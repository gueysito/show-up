use near_sdk::json_types::{Base64VecU8, U64, U128};
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
    pub custody_proof_policy: Option<CustodyProofPolicy>,
    pub native_nft: Option<NativeNftTerms>,
    pub observer_policy: Option<ObserverPolicy>,
}

/// Operator-qualified source profile is frozen with the event. Source labels
/// attest the observer's process; NEAR does not verify remote RPC independence.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ObserverPolicy {
    pub key: Base64VecU8,
    pub profile_hash: String,
    pub sources: [String; 2],
    pub operators: [String; 2],
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct AssetObservation {
    pub format: String,
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub network: String,
    pub chain_id: String,
    pub profile_hash: String,
    pub sources: [String; 2],
    pub collection: String,
    pub asset: String,
    pub custody: String,
    pub owner: String,
    pub operation: String,
    pub intent_hash: Option<String>,
    pub image_hash: Option<String>,
    pub transaction: Option<String>,
    pub transaction_block_height: Option<U64>,
    pub transaction_block_hash: Option<String>,
    pub transaction_ms: Option<u64>,
    pub block_height: near_sdk::json_types::U64,
    pub block_hash: String,
    pub block_ms: u64,
    pub observed_ms: u64,
    pub expires_ms: u64,
    pub finalized: bool,
    pub fee: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ObservationState {
    pub paused: bool,
    pub delivered: bool,
    pub fee_review_required: bool,
    pub latest: AssetObservation,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NativeNftTerms {
    pub token: AccountId,
    pub token_id: String,
    pub contributor: AccountId,
    pub fixture_beneficiary: AccountId,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NativePrize {
    pub held: bool,
    pub intent: Option<NativeNftIntent>,
    pub attempts: u64,
    pub pending: bool,
    pub delivered: bool,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct NativeNftIntent {
    pub operation: String,
    pub recipient: AccountId,
}

// Controlled P4 fixture policy, not a real prize/winner eligibility assertion.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CustodyProofPolicy {
    pub network: String,
    pub collection: String,
    pub asset: String,
    pub source: String,
    pub beneficiary: String,
    pub contributor: String,
    pub fee_cap: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustodyIntent {
    pub deployment: String,
    pub environment: String,
    pub network: String,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub payout: String,
    pub operation: String,
    pub collection: String,
    pub asset: String,
    pub source: String,
    pub recipient: String,
    pub fee_cap: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CustodyImage {
    pub intent_hash: String,
    pub path: String,
    pub scheme: String,
    pub unsigned: Base64VecU8,
    pub payload: Base64VecU8,
    pub envelope_hash: String,
    pub generation: u8,
    pub reserved_fee: U128,
    pub execution: ExecutionBounds,
    pub recovery_witness: Option<CustodyRecovery>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ExecutionBounds {
    pub evm_nonce: Option<U64>,
    pub evm_max_fee: Option<U128>,
    pub evm_priority_fee: Option<U128>,
    pub solana_blockhash: Option<String>,
    pub last_valid_block_height: Option<U64>,
    pub fee_exposure: U128,
    pub fee_bound_qualified: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CustodyRecovery {
    pub format: String,
    pub domain: String,
    pub deployment: AccountId,
    pub manifest: String,
    pub event: String,
    pub rules_hash: String,
    pub network: String,
    pub chain_id: String,
    pub profile_hash: String,
    pub sources: [String; 2],
    pub intent_hash: String,
    pub previous_image_hash: String,
    pub new_envelope_hash: String,
    pub reason: String,
    pub owner: String,
    pub account_nonce: Option<U64>,
    pub failed_image_hash: Option<String>,
    pub transaction: Option<String>,
    pub transaction_failed: bool,
    pub signature_status_absent: bool,
    pub blockhash_valid: Option<bool>,
    pub new_blockhash_valid: Option<bool>,
    pub transaction_block_height: Option<U64>,
    pub transaction_block_hash: Option<String>,
    pub reported_fee: U128,
    pub block_height: U64,
    pub block_hash: String,
    pub block_ms: u64,
    pub finalized_block_height: Option<U64>,
    pub observed_ms: u64,
    pub expires_ms: u64,
    pub nonce: String,
}

#[near(serializers = [json])]
pub struct EvmCustodyEnvelope {
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[near(serializers = [json])]
pub struct SolanaCustodyEnvelope {
    pub blockhash: String,
    pub compute_units: u32,
    pub estimated_fee: U128,
    pub last_valid_block_height: U64,
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
