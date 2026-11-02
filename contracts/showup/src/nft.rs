//! Native receipt/delivery prototype. Prescribed delivery recipient is a fixture;
//! real prize selection, collection/code allowlists and fee qualification remain gates.
use crate::*;
use near_sdk::{Gas, NearToken, Promise, PromiseError, ext_contract};

#[ext_contract(ext_nft)]
#[allow(dead_code)]
trait Nft {
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    );
}
#[ext_contract(ext_nft_self)]
#[allow(dead_code)]
trait NftCallbacks {
    fn on_native_nft(&mut self, event: String, attempt: u64) -> bool;
}

#[near(serializers=[json])]
struct NativeDeposit {
    event: String,
}

#[near]
impl Escrow {
    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> bool {
        if msg.len() > 1024 || token_id.len() > 256 {
            return true;
        }
        let Ok(message) = near_sdk::serde_json::from_str::<NativeDeposit>(&msg) else {
            return true;
        };
        let Some(item) = self.events.get(&message.event) else {
            return true;
        };
        let Some(terms) = &item.terms.native_nft else {
            return true;
        };
        if item.status != "draft"
            || now() >= item.terms.start_ms
            || terms.token != env::predecessor_account_id()
            || terms.token_id != token_id
            || terms.contributor != previous_owner_id
            || terms.contributor != sender_id
            || self.native_prizes.contains_key(&message.event)
        {
            return true;
        }
        self.native_prizes.insert(
            message.event,
            NativePrize {
                held: true,
                intent: None,
                attempts: 0,
                pending: false,
                delivered: false,
            },
        );
        false // NEP-171: keep the exact received asset.
    }

    #[private]
    pub fn lock_native_delivery(&mut self, event: String) -> NativePrize {
        let item = self.events.get(&event).expect("Unknown event");
        require!(
            item.status == "closed"
                && self
                    .draws
                    .get(&event)
                    .is_some_and(|draw| draw.state == "verified"),
            "Canonical fixture delivery decision missing"
        );
        let recipient = item
            .terms
            .native_nft
            .as_ref()
            .expect("Native prize missing")
            .fixture_beneficiary
            .clone();
        let prize = self.native_prizes.get_mut(&event).expect("Receipt missing");
        let intent = NativeNftIntent {
            operation: "delivery".into(),
            recipient,
        };
        if let Some(existing) = &prize.intent {
            require!(*existing == intent, "Opposite NFT intent forbidden");
        } else {
            prize.intent = Some(intent);
        }
        prize.clone()
    }

    pub fn recover_native_return(&mut self, event: String) -> NativePrize {
        let item = self.events.get(&event).expect("Unknown event");
        require!(
            item.status == "cancelled"
                || item.status == "aborted"
                || (item.status == "closed"
                    && self
                        .draws
                        .get(&event)
                        .is_some_and(|draw| draw.state == "timed_out")),
            "Return decision missing"
        );
        self.native_return(&event);
        self.native_prizes
            .get(&event)
            .expect("Receipt missing")
            .clone()
    }

    pub fn deliver_native_nft(&mut self, event: String) -> Promise {
        let terms = self
            .events
            .get(&event)
            .expect("Unknown event")
            .terms
            .native_nft
            .as_ref()
            .expect("Native prize missing")
            .clone();
        let prize = self.native_prizes.get_mut(&event).expect("Receipt missing");
        require!(
            prize.held && !prize.pending && !prize.delivered,
            "NFT transfer pending or delivered"
        );
        let recipient = prize
            .intent
            .as_ref()
            .expect("Lock NFT intent first")
            .recipient
            .clone();
        prize.attempts = prize.attempts.checked_add(1).expect("Attempt overflow");
        let attempt = prize.attempts;
        prize.pending = true;
        ext_nft::ext(terms.token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(35))
            .nft_transfer(
                recipient,
                terms.token_id,
                None,
                Some(format!("showup:{event}")),
            )
            .then(
                ext_nft_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_native_nft(event, attempt),
            )
    }

    #[private]
    pub fn on_native_nft(&mut self, event: String, attempt: u64) -> bool {
        require!(env::promise_results_count() == 1, "Invalid NFT callback");
        let prize = self.native_prizes.get_mut(&event).expect("Receipt missing");
        require!(
            prize.pending && prize.attempts == attempt,
            "Stale NFT callback"
        );
        prize.pending = false;
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            false
        } else {
            prize.delivered = true;
            prize.held = false;
            true
        }
    }

    pub fn get_native_prize(&self, event: String) -> Option<NativePrize> {
        self.native_prizes.get(&event).cloned()
    }
}

impl Escrow {
    pub(crate) fn native_return(&mut self, event: &String) {
        let Some(prize) = self.native_prizes.get_mut(event) else {
            return;
        };
        let terms = self
            .events
            .get(event)
            .unwrap()
            .terms
            .native_nft
            .as_ref()
            .unwrap();
        let intent = NativeNftIntent {
            operation: "return".into(),
            recipient: terms.contributor.clone(),
        };
        if let Some(existing) = &prize.intent {
            require!(*existing == intent, "Allocated NFT cannot be returned");
        } else {
            prize.intent = Some(intent);
        }
    }
}
