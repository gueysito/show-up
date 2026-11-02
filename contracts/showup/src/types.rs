use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, near};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Destination {
    pub network: String,
    pub asset: String,
    pub address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Authorization {
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub registration: String,
    pub participant: String,
    pub wallet_tag: String,
    pub principal: U128,
    pub source: Destination,
    pub refund: Destination,
    pub payout: Destination,
    pub fee_cap: U128,
    pub nonce: String,
    pub expires_ms: u64,
    pub reservation_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Terms {
    pub event: String,
    pub rules_hash: String,
    pub host: AccountId,
    pub mode: String,
    pub capacity: u32,
    pub principal: U128,
    pub sponsor_budget: U128,
    pub sponsor_return: Destination,
    pub start_ms: u64,
    pub end_ms: u64,
    pub latest_quiz_close_ms: u64,
    pub excluded: Vec<String>,
    pub draw_policy: Option<DrawPolicy>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DrawPolicy {
    pub provider: AccountId,
    pub project: String,
    pub version_hash: String,
    pub sender: AccountId,
    pub key: Base64VecU8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DrawProof {
    pub event: String,
    pub snapshot_hash: String,
    pub request_id: String,
    pub seed: String,
    pub alpha: String,
    pub created_ms: u64,
    pub deadline_ms: u64,
    pub attempts: u8,
    pub state: String,
    pub output: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub terms: Terms,
    pub status: String,
    pub sponsor_received: U128,
    pub reserved: Vec<String>,
    pub funded: Vec<String>,
    pub attendance: u32,
    pub ledger_version: u64,
    pub ended_ms: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Registration {
    pub authorization: Authorization,
    pub state: String,
    pub attendance: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TransferAttempt {
    pub number: u64,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Liability {
    pub destination: Destination,
    pub total: U128,
    pub paid: U128,
    pub attempts: u64,
    pub pending: Option<TransferAttempt>,
}

#[near(serializers = [json])]
pub struct AttendanceReceipt {
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub registration: String,
    pub participant: String,
    pub proof_class: String,
    pub received_ms: u64,
    pub nonce: String,
    pub expires_ms: u64,
}

#[near(serializers = [json])]
pub struct Reconciliation {
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub ledger_version: u64,
    pub complete_through_ms: u64,
    pub expires_ms: u64,
}

#[near(serializers = [json])]
pub struct ActionAuthorization {
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub registration: String,
    pub participant: String,
    pub operation: String,
    pub nonce: String,
    pub expires_ms: u64,
}
