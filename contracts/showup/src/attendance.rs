use crate::*;

#[near]
impl Escrow {
    pub fn release(&mut self, action: ActionAuthorization, proof: Base64VecU8) -> String {
        require!(
            action.domain == self.domain
                && action.deployment == env::current_account_id()
                && action.manifest == self.manifest
                && action.operation == "release"
                && valid_id(&action.nonce),
            "Wrong action domain"
        );
        signature(&action, &proof, &self.credential_key);
        let registration = action.registration.clone();
        let mut item = self
            .registrations
            .get(&registration)
            .expect("Unknown registration")
            .clone();
        let authorization = item.authorization.clone();
        require!(
            action.event == authorization.event && action.participant == authorization.participant,
            "Wrong action binding"
        );
        if item.state == "released" {
            return item.state;
        }
        let event = self.events.get(&authorization.event).unwrap();
        require!(
            now() < action.expires_ms && action.expires_ms <= now() + 300_000,
            "Action expired"
        );
        require!(
            event.status == "published" && now() < event.terms.start_ms - 600_000,
            "Release closed"
        );
        require!(item.state == "funded", "Not funded");
        item.state = "released".into();
        self.add_liability(
            format!("{registration}:principal"),
            authorization.payout.clone(),
            authorization.principal.0,
        );
        self.deactivate(&item);
        let event = self.events.get_mut(&authorization.event).unwrap();
        event.funded.retain(|id| id != &registration);
        event.ledger_version += 1;
        self.registrations.insert(registration, item);
        "released".into()
    }

    pub fn accept_attendance(&mut self, receipt: AttendanceReceipt, proof: Base64VecU8) -> String {
        require!(
            receipt.domain == self.domain
                && receipt.deployment == env::current_account_id()
                && receipt.manifest == self.manifest,
            "Wrong evidence domain"
        );
        signature(&receipt, &proof, &self.evidence_key);
        let mut item = self
            .registrations
            .get(&receipt.registration)
            .expect("Unknown registration")
            .clone();
        require!(
            receipt.event == item.authorization.event
                && receipt.participant == item.authorization.participant
                && receipt.rules_hash == item.authorization.rules_hash
                && valid_id(&receipt.nonce),
            "Wrong evidence binding"
        );
        if let Some(state) = item.attendance {
            return state;
        }
        let event = self.events.get(&receipt.event).unwrap();
        let start = event.terms.start_ms;
        let cutoff = event.terms.end_ms - 900_000;
        require!(
            event.status == "published" && item.state == "funded",
            "Not eligible"
        );
        require!(
            receipt.received_ms >= start - 300_000
                && receipt.received_ms <= cutoff
                && receipt.received_ms <= now()
                && now() <= receipt.expires_ms
                && receipt.expires_ms <= cutoff + 300_000,
            "Evidence outside window"
        );
        require!(
            (event.terms.mode == "online" && receipt.proof_class == "live_code")
                || (event.terms.mode == "physical" && receipt.proof_class == "staff_qr"),
            "Wrong proof class"
        );
        let classification = if receipt.received_ms <= start + 600_000 {
            "on_time"
        } else {
            "late"
        };
        item.attendance = Some(classification.into());
        self.registrations.insert(receipt.registration, item);
        let event = self.events.get_mut(&receipt.event).unwrap();
        event.attendance += 1;
        event.ledger_version += 1;
        classification.into()
    }

    pub fn cancel_or_abort(&mut self, event: String) -> String {
        let item = self.events.get(&event).expect("Unknown event");
        require!(
            env::predecessor_account_id() == item.terms.host,
            "Host only"
        );
        if item.status == "cancelled" || item.status == "aborted" {
            return item.status.clone();
        }
        require!(item.status == "published", "Already resolved");
        require!(
            now() < interaction_close(item) + 300_000,
            "Normal closing required"
        );
        let status = if now() < item.terms.start_ms {
            "cancelled"
        } else {
            "aborted"
        };
        self.resolve(&event, status, true);
        status.into()
    }

    pub fn close(&mut self, checkpoint: Reconciliation, proof: Base64VecU8) -> String {
        require!(
            checkpoint.domain == self.domain
                && checkpoint.deployment == env::current_account_id()
                && checkpoint.manifest == self.manifest,
            "Wrong checkpoint domain"
        );
        signature(&checkpoint, &proof, &self.evidence_key);
        let event = self.events.get(&checkpoint.event).expect("Unknown event");
        require!(
            event.status == "published"
                && checkpoint.rules_hash == event.terms.rules_hash
                && checkpoint.ledger_version == event.ledger_version,
            "Stale checkpoint"
        );
        require!(
            checkpoint.complete_through_ms >= interaction_close(event)
                && checkpoint.complete_through_ms <= now()
                && now() <= checkpoint.expires_ms
                && checkpoint.expires_ms <= event.terms.end_ms + 2_100_000,
            "Incomplete evidence"
        );
        require!(
            now() >= interaction_close(event) + 300_000
                && (event.ended_ms.is_some() || now() >= event.terms.end_ms + 2_100_000),
            "Evidence grace pending"
        );
        let neutral = event.attendance == 0;
        let status = if neutral { "aborted" } else { "closed" };
        self.resolve(&checkpoint.event, status, neutral);
        status.into()
    }

    pub fn record_end(&mut self, event: String) {
        let item = self.events.get_mut(&event).expect("Unknown event");
        require!(
            env::predecessor_account_id() == item.terms.host,
            "Host only"
        );
        require!(
            item.status == "published" && now() >= item.terms.start_ms,
            "Cannot record end"
        );
        if item.ended_ms.is_none() {
            item.ended_ms = Some(now());
        }
    }

    pub fn fail_neutral(&mut self, event: String) -> String {
        let item = self.events.get(&event).expect("Unknown event");
        if item.status != "published" {
            return item.status.clone();
        }
        require!(
            now() >= item.terms.end_ms + 2_100_000,
            "Reconciliation deadline pending"
        );
        self.resolve(&event, "aborted", true);
        "aborted".into()
    }
}

fn interaction_close(event: &Event) -> u64 {
    (event.terms.end_ms - 900_000).max(event.terms.latest_quiz_close_ms)
}

impl Escrow {
    fn resolve(&mut self, id: &String, status: &str, neutral: bool) {
        let item = self.events.get(id).unwrap().clone();
        for registration in &item.funded {
            let mut entry = self.registrations.get(registration).unwrap().clone();
            if neutral || entry.attendance.is_some() {
                self.add_liability(
                    format!("{registration}:principal"),
                    entry.authorization.payout.clone(),
                    entry.authorization.principal.0,
                );
                entry.state = "refund_owed".into();
            } else {
                entry.state = "forfeiture_held".into();
            }
            self.registrations.insert(registration.clone(), entry);
        }
        if neutral && item.sponsor_received.0 > 0 {
            self.add_liability(
                format!("{id}:sponsor"),
                item.terms.sponsor_return.clone(),
                item.sponsor_received.0,
            );
        }
        self.events.get_mut(id).unwrap().status = status.into();
    }
}
