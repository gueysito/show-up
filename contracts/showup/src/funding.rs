use crate::*;
use near_sdk::PromiseOrValue;
use near_sdk::json_types::Base64VecU8;

#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Deposit {
    Commitment {
        authorization: Box<Authorization>,
        proof: Base64VecU8,
    },
    Sponsor {
        event: String,
    },
}

#[near]
impl Escrow {
    pub fn reserve(&mut self, authorization: Authorization, proof: Base64VecU8) -> String {
        let _ = self.check_authorization(&authorization, &proof);
        require!(now() < authorization.expires_ms, "Authorization expired");
        if let Some(existing) = self.registrations.get(&authorization.registration) {
            require!(
                existing.authorization == authorization,
                "Registration collision"
            );
            return existing.state.clone();
        }
        self.clean_reservations(&authorization.event);
        let event = self
            .events
            .get(&authorization.event)
            .expect("Unknown event");
        require!(
            event.status == "published" && now() < event.terms.start_ms,
            "Registration closed"
        );
        require!(
            event.funded.len() + event.reserved.len() < event.terms.capacity as usize,
            "Event full"
        );
        require!(
            !event.terms.excluded.contains(&authorization.participant),
            "Excluded participant"
        );
        self.check_active(&authorization);
        self.bind(&authorization);
        self.events
            .get_mut(&authorization.event)
            .unwrap()
            .reserved
            .push(authorization.registration.clone());
        self.registrations.insert(
            authorization.registration.clone(),
            Registration {
                authorization,
                state: "reserved".into(),
                attendance: None,
            },
        );
        "reserved".into()
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "Wrong settlement token"
        );
        require!(amount.0 > 0 && msg.len() <= 16384, "Invalid receipt");
        let deposit: Deposit =
            near_sdk::serde_json::from_str(&msg).expect("Invalid receipt binding");
        match deposit {
            Deposit::Sponsor { event } => {
                let item = self.events.get_mut(&event).expect("Unknown event");
                require!(
                    item.status == "draft"
                        && item.terms.sponsor_return.network == "near"
                        && item.terms.sponsor_return.address == sender_id.as_str(),
                    "Unauthorized sponsor"
                );
                require!(
                    amount.0 == item.terms.sponsor_budget.0 && item.sponsor_received.0 == 0,
                    "Wrong sponsor amount"
                );
                item.sponsor_received = amount;
            }
            Deposit::Commitment {
                authorization,
                proof,
            } => self.receive(*authorization, proof, amount.0, &sender_id),
        }
        self.received = self
            .received
            .checked_add(amount.0)
            .expect("Amount overflow");
        PromiseOrValue::Value(U128(0))
    }
}

impl Escrow {
    pub(crate) fn check_authorization(
        &self,
        auth: &Authorization,
        proof: &Base64VecU8,
    ) -> Option<financial::FundingConsent> {
        require!(
            auth.domain == self.domain
                && auth.deployment == env::current_account_id()
                && auth.manifest == self.manifest,
            "Wrong authorization domain"
        );
        for id in [
            &auth.registration,
            &auth.participant,
            &auth.wallet_tag,
            &auth.nonce,
        ] {
            require!(valid_id(id), "Invalid credential identifier");
        }
        let event = self.events.get(&auth.event).expect("Unknown event");
        require!(
            event.terms.rules_hash == auth.rules_hash && event.terms.principal == auth.principal,
            "Wrong rules/amount"
        );
        require!(
            auth.reservation_ms <= auth.expires_ms && auth.reservation_ms <= event.terms.start_ms,
            "Invalid reservation expiry"
        );
        require!(
            auth.reservation_ms <= now().saturating_add(300_000),
            "Reservation exceeds five minutes"
        );
        self.valid_destination(&auth.refund);
        self.valid_destination(&auth.source);
        require!(
            auth.source.network == "near",
            "External funding source unqualified"
        );
        self.valid_destination(&auth.payout);
        require!(auth.fee_cap.0 < auth.principal.0, "Invalid fee cap");
        signature(auth, proof, &self.credential_key);
        if let Some(bound) = self.nonces.get(&format!("{}:{}", auth.event, auth.nonce)) {
            require!(bound == &auth.registration, "Nonce replay");
        }
        if let Some(existing) = self.registrations.get(&auth.registration) {
            require!(
                &existing.authorization == auth,
                "Registration binding changed"
            );
        }
        self.check_financial_consent(auth)
    }

    fn check_active(&self, auth: &Authorization) {
        require!(!self.active_conflict(auth), "Already registered");
    }

    fn bind(&mut self, auth: &Authorization) {
        self.active_participants.insert(
            format!("{}:{}", auth.event, auth.participant),
            auth.registration.clone(),
        );
        for key in wallet_keys(auth) {
            self.active_wallets.insert(key, auth.registration.clone());
        }
        self.nonces.insert(
            format!("{}:{}", auth.event, auth.nonce),
            auth.registration.clone(),
        );
    }

    fn clean_reservations(&mut self, event_id: &String) {
        let ids = self
            .events
            .get(event_id)
            .expect("Unknown event")
            .reserved
            .clone();
        let mut keep = vec![];
        for id in ids {
            let registration = self.registrations.get(&id).unwrap().clone();
            if registration.authorization.reservation_ms > now() {
                keep.push(id);
            } else {
                self.deactivate(&registration);
            }
        }
        self.events.get_mut(event_id).unwrap().reserved = keep;
    }

    fn receive(
        &mut self,
        auth: Authorization,
        proof: Base64VecU8,
        amount: u128,
        sender: &AccountId,
    ) {
        let consent = self.check_authorization(&auth, &proof);
        require!(
            auth.source.address == sender.as_str(),
            "Wrong funding wallet"
        );
        if let Some(consent) = consent {
            let key = env::signer_account_pk();
            require!(
                env::signer_account_id().as_str() == auth.source.address
                    && key.as_bytes().len() == 33
                    && key.as_bytes()[0] == 0
                    && key.as_bytes()[1..] == consent.public_key,
                "Financial consent key does not match the actual source signer"
            );
            require!(
                amount <= consent.maximum_input,
                "Source amount exceeds financial consent"
            );
        }
        self.clean_reservations(&auth.event);
        let existing = self.registrations.get(&auth.registration).cloned();
        let event = self.events.get(&auth.event).unwrap();
        let own_reserved = event.reserved.contains(&auth.registration);
        let space = event.funded.len() + event.reserved.len() - usize::from(own_reserved)
            < event.terms.capacity as usize;
        let active = !self.active_conflict(&auth);
        let enroll = event.status == "published"
            && now() < event.terms.start_ms
            && now() < auth.expires_ms
            && space
            && active
            && !event.terms.excluded.contains(&auth.participant)
            && amount >= auth.principal.0
            && existing
                .as_ref()
                .is_none_or(|item| item.state == "reserved" || item.state == "return_only");
        let returned = if enroll {
            amount - auth.principal.0
        } else {
            amount
        };
        if returned > 0 {
            self.add_liability(
                format!("{}:return", auth.registration),
                auth.refund.clone(),
                returned,
            );
        }
        if enroll {
            self.bind(&auth);
            let event = self.events.get_mut(&auth.event).unwrap();
            event.reserved.retain(|id| id != &auth.registration);
            event.funded.push(auth.registration.clone());
            event.ledger_version += 1;
            self.registrations.insert(
                auth.registration.clone(),
                Registration {
                    authorization: auth,
                    state: "funded".into(),
                    attendance: None,
                },
            );
        } else if existing.is_none() {
            self.nonces.insert(
                format!("{}:{}", auth.event, auth.nonce),
                auth.registration.clone(),
            );
            self.registrations.insert(
                auth.registration.clone(),
                Registration {
                    authorization: auth,
                    state: "return_only".into(),
                    attendance: None,
                },
            );
        }
    }
}
