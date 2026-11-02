//! NEAR settlement authority. Local sandbox proof does not qualify external routes.
mod attendance;
mod canonical;
mod custody;
mod delivery;
mod draw;
mod funding;
mod nft;
mod types;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, PanicOnDefault, env, near, require, store::LookupMap};
pub use types::*;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    owner: AccountId,
    token: AccountId,
    domain: String,
    manifest: String,
    credential_key: [u8; 32],
    evidence_key: [u8; 32],
    events: LookupMap<String, Event>,
    registrations: LookupMap<String, Registration>,
    active_participants: LookupMap<String, String>,
    active_wallets: LookupMap<String, String>,
    nonces: LookupMap<String, String>,
    liabilities: LookupMap<String, Liability>,
    draws: LookupMap<String, DrawProof>,
    custody_intents: LookupMap<String, CustodyIntent>,
    custody_images: LookupMap<String, CustodyImage>,
    native_prizes: LookupMap<String, NativePrize>,
    received: u128,
    delivered: u128,
    owed: u128,
}

#[near]
impl Escrow {
    #[init]
    pub fn new(
        token: AccountId,
        domain: String,
        manifest: String,
        credential_key: Base64VecU8,
        evidence_key: Base64VecU8,
    ) -> Self {
        require!(
            domain == "showup.sandbox.authorization.v1",
            "Prototype is sandbox-only"
        );
        let credential_key: [u8; 32] = credential_key.0.try_into().expect("Credential key length");
        let evidence_key: [u8; 32] = evidence_key.0.try_into().expect("Evidence key length");
        require!(
            credential_key != evidence_key,
            "Separate credential and evidence keys required"
        );
        Self {
            owner: env::predecessor_account_id(),
            token,
            domain,
            manifest,
            credential_key,
            evidence_key,
            events: LookupMap::new(b"e"),
            registrations: LookupMap::new(b"r"),
            active_participants: LookupMap::new(b"p"),
            active_wallets: LookupMap::new(b"w"),
            nonces: LookupMap::new(b"n"),
            liabilities: LookupMap::new(b"l"),
            draws: LookupMap::new(b"d"),
            custody_intents: LookupMap::new(&b"ci"[..]),
            custody_images: LookupMap::new(&b"cs"[..]),
            native_prizes: LookupMap::new(b"q"),
            received: 0,
            delivered: 0,
            owed: 0,
        }
    }

    pub fn create_event(&mut self, terms: Terms) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Publisher only"
        );
        require!(!self.events.contains_key(&terms.event), "Event exists");
        require!(
            valid_id(&terms.event) && valid_id(&terms.rules_hash),
            "Invalid identifiers"
        );
        require!(
            terms.rules_hash == self.compute_rules_hash(terms.clone()),
            "Rules hash does not match frozen terms"
        );
        require!(
            terms.mode == "online" || terms.mode == "physical",
            "Invalid mode"
        );
        require!(
            (1..=100).contains(&terms.capacity) && terms.principal.0 > 0,
            "Invalid capacity/principal"
        );
        let duration = terms
            .end_ms
            .checked_sub(terms.start_ms)
            .expect("Invalid schedule");
        require!(
            (1_800_000..=7_200_000).contains(&duration),
            "Invalid duration"
        );
        require!(
            terms.start_ms > now() && terms.end_ms <= u64::MAX - 2_100_000,
            "Invalid future schedule"
        );
        require!(
            terms.latest_quiz_close_ms == 0
                || (terms.latest_quiz_close_ms >= terms.start_ms
                    && terms.latest_quiz_close_ms <= terms.end_ms),
            "Quiz outside published schedule"
        );
        self.valid_destination(&terms.sponsor_return);
        if let Some(prize) = &terms.native_nft {
            require!(
                !prize.token_id.is_empty()
                    && prize.token_id.len() <= 256
                    && prize.fixture_beneficiary != prize.contributor
                    && prize.fixture_beneficiary != terms.host,
                "Invalid native prize terms"
            );
        }
        if let Some(policy) = &terms.custody_proof_policy {
            custody::validate_policy(policy);
        }
        if let Some(policy) = &terms.draw_policy {
            require!(valid_id(&policy.version_hash), "Invalid draw version");
            require!(policy.key.0.len() == 32, "Draw key length");
            require!(
                policy.key.0 != self.credential_key && policy.key.0 != self.evidence_key,
                "Separate draw key required"
            );
            require!(
                !policy.project.is_empty()
                    && policy.project.len() <= 128
                    && policy
                        .project
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"./_-".contains(&byte)),
                "Invalid draw project"
            );
        }
        require!(
            terms.excluded.iter().all(|value| valid_id(value)),
            "Invalid exclusion roster"
        );
        self.events.insert(
            terms.event.clone(),
            Event {
                terms,
                status: "draft".into(),
                sponsor_received: U128(0),
                reserved: vec![],
                funded: vec![],
                attendance: 0,
                ledger_version: 0,
                ended_ms: None,
            },
        );
    }

    pub fn publish(&mut self, event: String) {
        let item = self.events.get_mut(&event).expect("Unknown event");
        require!(
            env::predecessor_account_id() == item.terms.host,
            "Host only"
        );
        require!(
            item.status == "draft" && now() < item.terms.start_ms,
            "Cannot publish"
        );
        require!(
            item.sponsor_received == item.terms.sponsor_budget,
            "Sponsor funding missing"
        );
        if item.terms.native_nft.is_some() {
            require!(
                self.native_prizes
                    .get(&event)
                    .is_some_and(|prize| prize.held && prize.intent.is_none()),
                "Native NFT escrow receipt missing"
            );
        }
        item.status = "published".into();
    }

    pub fn get_event(&self, event: String) -> Option<Event> {
        self.events.get(&event).cloned()
    }
    pub fn compute_rules_hash(&self, terms: Terms) -> String {
        let mut value = near_sdk::serde_json::to_value(terms).expect("Terms serialization");
        value.as_object_mut().unwrap().remove("rules_hash");
        let context = near_sdk::serde_json::json!({"format":"showup.event.rules.v1","authorization_domain":self.domain,
            "deployment":env::current_account_id(),"manifest":self.manifest,"settlement_token":self.token,"terms":value});
        env::sha256(canonical::bytes(&context))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
    pub fn get_registration(&self, registration: String) -> Option<Registration> {
        self.registrations.get(&registration).cloned()
    }
    pub fn get_liability(&self, id: String) -> Option<Liability> {
        self.liabilities.get(&id).cloned()
    }
    pub fn accounting(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"received": U128(self.received), "delivered": U128(self.delivered),
            "owed": U128(self.owed), "unallocated": U128(self.received - self.delivered - self.owed)})
    }
}

fn now() -> u64 {
    env::block_timestamp_ms()
}
fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn signature<T: near_sdk::serde::Serialize>(value: &T, proof: &Base64VecU8, key: &[u8; 32]) {
    let proof: [u8; 64] = proof.0.clone().try_into().expect("Signature length");
    let bytes = canonical::bytes(value);
    require!(env::ed25519_verify(&proof, bytes, key), "Invalid signature");
}

impl Escrow {
    fn valid_destination(&self, destination: &Destination) {
        require!(
            ["near", "base", "ethereum", "solana"].contains(&destination.network.as_str()),
            "Unsupported network"
        );
        require!(
            !destination.asset.is_empty() && destination.asset.len() <= 128,
            "Invalid asset"
        );
        require!(
            !destination.address.is_empty() && destination.address.len() <= 128,
            "Invalid address"
        );
        if destination.network == "near" {
            require!(
                destination.asset == self.token.as_str(),
                "Wrong settlement token"
            );
            destination
                .address
                .parse::<AccountId>()
                .expect("Invalid NEAR destination");
        }
    }

    fn deactivate(&mut self, registration: &Registration) {
        let auth = &registration.authorization;
        let participant_key = format!("{}:{}", auth.event, auth.participant);
        if self.active_participants.get(&participant_key) == Some(&auth.registration) {
            self.active_participants.remove(&participant_key);
        }
        for key in wallet_keys(auth) {
            if self.active_wallets.get(&key) == Some(&auth.registration) {
                self.active_wallets.remove(&key);
            }
        }
    }

    fn active_conflict(&self, auth: &Authorization) -> bool {
        self.active_participants
            .get(&format!("{}:{}", auth.event, auth.participant))
            .is_some_and(|id| id != &auth.registration)
            || wallet_keys(auth).iter().any(|key| {
                self.active_wallets
                    .get(key)
                    .is_some_and(|id| id != &auth.registration)
            })
    }
}

fn wallet_keys(auth: &Authorization) -> [String; 2] {
    [
        format!("{}:tag:{}", auth.event, auth.wallet_tag),
        format!(
            "{}:source:{}:{}:{}",
            auth.event, auth.source.network, auth.source.asset, auth.source.address
        ),
    ]
}
