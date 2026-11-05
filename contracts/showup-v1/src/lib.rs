//! V1 USDC escrow. Local operator binds wallets/attendance; receipts move money.
mod nft;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env, near,
    require, store::LookupMap,
};
pub use nft::*;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub id: String,
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub capacity: u32,
    pub deposit: U128,
    pub prize: U128,
    pub prize_received: bool,
    pub sponsor: AccountId,
    pub status: String,
    pub funded: Vec<String>,
    pub winner: Option<String>,
    pub nft: Option<NftPrize>,
}

#[near(serializers = [json])]
pub struct EventTerms {
    pub id: String,
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub capacity: u32,
    pub deposit: U128,
    pub prize: U128,
    pub sponsor: AccountId,
    pub nft: Option<NftPrize>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Registration {
    pub id: String,
    pub event: String,
    pub sender: AccountId,
    pub payout: AccountId,
    pub ethereum: Option<String>,
    pub funded: bool,
    pub attended: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Claim {
    pub recipient: AccountId,
    pub remaining: U128,
    pub paid: U128,
    pub pending: bool,
    pub attempt: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EscrowV1 {
    owner: AccountId,
    token: AccountId,
    signer: AccountId,
    events: LookupMap<String, Event>,
    registrations: LookupMap<String, Registration>,
    participants: LookupMap<String, String>,
    claims: LookupMap<String, Claim>,
    received: u128,
    paid: u128,
}

#[near]
impl EscrowV1 {
    #[init]
    pub fn new(owner: AccountId, token: AccountId, signer: AccountId) -> Self {
        Self {
            owner,
            token,
            signer,
            events: LookupMap::new(b"e"),
            registrations: LookupMap::new(b"r"),
            participants: LookupMap::new(b"p"),
            claims: LookupMap::new(b"c"),
            received: 0,
            paid: 0,
        }
    }

    pub fn create_event(&mut self, terms: EventTerms) {
        self.only_owner();
        let EventTerms {
            id,
            title,
            start_ms,
            end_ms,
            capacity,
            deposit,
            prize,
            sponsor,
            nft,
        } = terms;
        valid_id(&id);
        require!(!self.events.contains_key(&id), "Event exists");
        require!(
            !title.is_empty() && title.len() <= 160 && now() < start_ms && start_ms < end_ms,
            "Invalid event"
        );
        require!(
            (1..=64).contains(&capacity)
                && (1_000_000..=100_000_000).contains(&deposit.0)
                && prize.0 <= 100_000_000,
            "V1 amount/capacity limit"
        );
        if let Some(value) = &nft {
            value.validate_new();
        }
        self.events.insert(
            id.clone(),
            Event {
                id,
                title,
                start_ms,
                end_ms,
                capacity,
                deposit,
                prize,
                prize_received: prize.0 == 0,
                sponsor,
                status: "draft".into(),
                funded: vec![],
                winner: None,
                nft,
            },
        );
    }

    pub fn publish(&mut self, event: String) {
        self.only_owner();
        let item = self.events.get_mut(&event).expect("Unknown event");
        require!(
            item.status == "draft" && now() < item.start_ms && item.prize_received,
            "Publication not ready"
        );
        require!(
            item.nft
                .as_ref()
                .is_none_or(|n| n.held && n.custody.is_some()),
            "NFT not in custody"
        );
        item.status = "published".into();
    }

    pub fn register(
        &mut self,
        id: String,
        event: String,
        sender: AccountId,
        payout: AccountId,
        ethereum: Option<String>,
    ) {
        self.only_owner();
        valid_id(&id);
        let item = self.events.get(&event).expect("Unknown event");
        require!(
            item.status == "published" && now() < item.start_ms,
            "Registration closed"
        );
        // In V1 the sponsor is the host's NEAR funding/return wallet.
        require!(
            payout != item.sponsor && sender != item.sponsor,
            "Host cannot receive attendee payouts"
        );
        if let Some(address) = &ethereum {
            evm_address(address);
        }
        require!(
            item.nft.is_none() || ethereum.is_some(),
            "NFT recipient required"
        );
        let key = format!("{event}:{payout}");
        require!(
            !self.participants.contains_key(&key) && !self.registrations.contains_key(&id),
            "Already registered"
        );
        self.participants.insert(key, id.clone());
        self.registrations.insert(
            id.clone(),
            Registration {
                id,
                event,
                sender,
                payout,
                ethereum,
                funded: false,
                attended: false,
            },
        );
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "Wrong token");
        require!(msg.len() <= 256 && amount.0 > 0, "Invalid receipt");
        // Prefixes are short references bound by the operator before payment.
        if let Some(event) = msg.strip_prefix("prize:") {
            let item = self.events.get_mut(event).expect("Unknown event");
            require!(
                item.status == "draft"
                    && sender_id == item.sponsor
                    && amount == item.prize
                    && !item.prize_received,
                "Invalid prize funding"
            );
            item.prize_received = true;
        } else {
            let id = msg
                .strip_prefix("deposit:")
                .expect("Invalid registration reference");
            let registration = self
                .registrations
                .get(id)
                .expect("Unknown registration")
                .clone();
            let item = self.events.get_mut(&registration.event).unwrap();
            require!(
                sender_id == registration.sender && amount == item.deposit,
                "Wrong sender/amount"
            );
            if registration.funded
                || item.status != "published"
                || now() >= item.start_ms
                || item.funded.len() >= item.capacity as usize
            {
                return PromiseOrValue::Value(amount);
            }
            item.funded.push(id.into());
            self.registrations.get_mut(id).unwrap().funded = true;
        }
        self.received = self
            .received
            .checked_add(amount.0)
            .expect("Amount overflow");
        PromiseOrValue::Value(U128(0))
    }

    pub fn check_in(&mut self, registration: String) {
        self.only_owner();
        let item = self
            .registrations
            .get(&registration)
            .expect("Unknown registration");
        let event = self.events.get(&item.event).unwrap();
        require!(
            item.funded
                && event.status == "published"
                && now() >= event.start_ms
                && now() < event.end_ms,
            "Check-in closed/unfunded"
        );
        self.registrations.get_mut(&registration).unwrap().attended = true;
    }

    pub fn settle(&mut self, event: String) {
        let item = self.events.get(&event).expect("Unknown event").clone();
        require!(
            item.status == "published" && now() >= item.start_ms,
            "Cannot settle"
        );
        require!(
            env::predecessor_account_id() == self.owner || now() >= item.end_ms,
            "Host only before deadline"
        );
        let attended: Vec<_> = item
            .funded
            .iter()
            .filter(|id| self.registrations.get(id.as_str()).unwrap().attended)
            .cloned()
            .collect();
        let mut winner = None;
        if attended.is_empty() {
            for id in &item.funded {
                let registration = self.registrations.get(id).unwrap().clone();
                self.add_claim(id.clone(), registration.payout, item.deposit.0);
            }
            if item.prize.0 > 0 {
                self.add_claim(format!("prize:{event}"), item.sponsor, item.prize.0);
            }
        } else {
            let forfeited = (item.funded.len() - attended.len()) as u128 * item.deposit.0;
            let count = attended.len() as u128;
            let mut seed = env::random_seed();
            seed.extend_from_slice(event.as_bytes());
            let entropy = env::sha256(seed);
            let draw =
                u64::from_le_bytes(entropy[..8].try_into().unwrap()) as usize % attended.len();
            for (index, id) in attended.iter().enumerate() {
                let registration = self.registrations.get(id).unwrap().clone();
                let share = forfeited / count + u128::from((index as u128) < forfeited % count);
                let prize = if index == draw {
                    winner = Some(id.clone());
                    item.prize.0
                } else {
                    0
                };
                self.add_claim(
                    id.clone(),
                    registration.payout,
                    item.deposit.0 + share + prize,
                );
            }
        }
        let stored = self.events.get_mut(&event).unwrap();
        stored.status = "settled".into();
        stored.winner = winner;
    }

    pub fn cancel(&mut self, event: String) {
        self.only_owner();
        let item = self.events.get(&event).expect("Unknown event").clone();
        require!(
            item.status == "draft" || item.status == "published",
            "Already closed"
        );
        for id in &item.funded {
            let registration = self.registrations.get(id).unwrap().clone();
            self.add_claim(id.clone(), registration.payout, item.deposit.0);
        }
        if item.prize_received && item.prize.0 > 0 {
            self.add_claim(format!("prize:{event}"), item.sponsor, item.prize.0);
        }
        self.events.get_mut(&event).unwrap().status = "cancelled".into();
    }

    pub fn withdraw(&mut self, claim: String) -> Promise {
        let item = self.claims.get_mut(&claim).expect("No claim");
        require!(
            !item.pending && item.remaining.0 > 0,
            "Pending/already paid"
        );
        item.pending = true;
        item.attempt += 1;
        Promise::new(self.token.clone()).function_call("ft_transfer", bytes(&json!({"receiver_id":item.recipient,"amount":item.remaining,"memo":"Showup V1"})), NearToken::from_yoctonear(1), Gas::from_tgas(25))
            .then(Promise::new(env::current_account_id()).function_call("on_withdraw", bytes(&json!({"claim":claim,"attempt":item.attempt})), NearToken::from_yoctonear(0), Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_withdraw(&mut self, claim: String, attempt: u64) -> bool {
        require!(env::promise_results_count() == 1, "Invalid callback");
        let item = self.claims.get_mut(&claim).expect("No claim");
        require!(item.pending && item.attempt == attempt, "Stale callback");
        item.pending = false;
        let success = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if success {
            self.paid += item.remaining.0;
            item.paid.0 += item.remaining.0;
            item.remaining = U128(0);
        }
        success
    }

    pub fn get_event(&self, event: String) -> Option<Event> {
        self.events.get(&event).cloned()
    }
    pub fn get_registration(&self, registration: String) -> Option<Registration> {
        self.registrations.get(&registration).cloned()
    }
    pub fn get_claim(&self, claim: String) -> Option<Claim> {
        self.claims.get(&claim).cloned()
    }
    pub fn accounting(&self) -> Value {
        json!({"received":U128(self.received),"paid":U128(self.paid),"held":U128(self.received-self.paid)})
    }
}

impl EscrowV1 {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Operator only");
    }
    fn add_claim(&mut self, id: String, recipient: AccountId, amount: u128) {
        require!(
            !self.claims.contains_key(&id) && amount > 0,
            "Claim exists/empty"
        );
        self.claims.insert(
            id,
            Claim {
                recipient,
                remaining: U128(amount),
                paid: U128(0),
                pending: false,
                attempt: 0,
            },
        );
    }
}
fn valid_id(value: &str) {
    require!(
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
        "Invalid identifier"
    );
}
fn now() -> u64 {
    env::block_timestamp_ms()
}
fn bytes(value: &Value) -> Vec<u8> {
    near_sdk::serde_json::to_vec(value).unwrap()
}
