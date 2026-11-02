//! Platform-attested external state, separate from irreversible release authority.
//! The observer remains trusted for source independence, finality and ownership.
use crate::*;

pub(crate) fn validate_policy(terms: &Terms, credential: &[u8; 32], evidence: &[u8; 32]) {
    if let Some(policy) = &terms.observer_policy {
        require!(
            terms.custody_proof_policy.is_some(),
            "External custody policy missing"
        );
        require!(
            policy.key.0.len() == 32
                && policy.key.0 != credential
                && policy.key.0 != evidence
                && terms
                    .draw_policy
                    .as_ref()
                    .is_none_or(|draw| draw.key != policy.key),
            "Separate observer key required"
        );
        require!(valid_id(&policy.profile_hash), "Invalid observer profile");
        require!(
            policy.sources[0] != policy.sources[1]
                && policy.operators[0] != policy.operators[1]
                && policy
                    .sources
                    .iter()
                    .chain(&policy.operators)
                    .all(|id| !id.is_empty()
                        && id.len() <= 64
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))),
            "Distinct fixed observer sources/operators required"
        );
    }
}

fn chain(network: &str) -> &str {
    match network {
        "base" => "84532",
        "ethereum" => "11155111",
        "solana" => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        _ => env::panic_str("Unsupported observation chain"),
    }
}
fn hash(network: &str, value: &str, transaction: bool) {
    if network == "solana" {
        let expected = if transaction { 64 } else { 32 };
        require!(value.len() <= 88, "Observation hash length");
        let bytes = bs58::decode(value)
            .into_vec()
            .expect("Invalid observation Base58");
        require!(
            bytes.len() == expected && bs58::encode(bytes).into_string() == value,
            "Invalid observation hash"
        );
    } else {
        require!(
            value.len() == 66 && value.starts_with("0x") && valid_id(&value[2..]),
            "Invalid observation hash"
        );
    }
}

#[near]
impl Escrow {
    pub fn observe_asset(
        &mut self,
        receipt: AssetObservation,
        proof: Base64VecU8,
    ) -> ObservationState {
        let item = self
            .events
            .get(&receipt.event)
            .expect("Unknown observation event");
        let asset = item
            .terms
            .custody_proof_policy
            .as_ref()
            .expect("External custody missing");
        let policy = item
            .terms
            .observer_policy
            .as_ref()
            .expect("Observer profile missing");
        let key: [u8; 32] = policy.key.0.clone().try_into().unwrap();
        signature(&receipt, &proof, &key);
        require!(
            receipt.format == "showup.asset.observation.v1"
                && receipt.domain == self.domain
                && receipt.deployment == env::current_account_id()
                && receipt.manifest == "showup-engineering-2026-11-02-v1"
                && receipt.rules_hash == item.terms.rules_hash
                && receipt.network == asset.network
                && receipt.chain_id == chain(&asset.network)
                && receipt.profile_hash == policy.profile_hash
                && receipt.sources == policy.sources
                && receipt.collection == asset.collection
                && receipt.asset == asset.asset
                && receipt.custody == asset.source,
            "Observation context mismatch"
        );
        require!(
            receipt.finalized
                && receipt.block_height.0 > 0
                && receipt.block_ms <= receipt.observed_ms
                && receipt.observed_ms <= now()
                && now() - receipt.observed_ms <= 60_000
                && receipt.observed_ms - receipt.block_ms
                    <= if asset.network == "solana" {
                        120_000
                    } else {
                        1_800_000
                    }
                && receipt.expires_ms > now()
                && receipt.expires_ms > receipt.observed_ms
                && receipt.expires_ms - receipt.observed_ms <= 60_000,
            "Stale or insufficiently final observation"
        );
        hash(&receipt.network, &receipt.block_hash, false);
        if receipt.network == "solana" {
            hash(&receipt.network, &receipt.owner, false);
        } else {
            require!(
                receipt.owner.len() == 42
                    && receipt.owner.starts_with("0x")
                    && receipt.owner[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    && receipt.owner[2..].bytes().any(|byte| byte != b'0'),
                "Invalid observed owner"
            );
        }
        let delivered = receipt.operation == "delivery" || receipt.operation == "return";
        if delivered {
            let intent = self
                .custody_intents
                .get(&receipt.event)
                .expect("No canonical release intent");
            let image = self
                .custody_images
                .get(&receipt.event)
                .expect("No signing image");
            require!(
                receipt.operation == intent.operation
                    && receipt.owner == intent.recipient
                    && receipt.intent_hash.as_ref() == Some(&image.intent_hash)
                    && receipt.image_hash.as_ref() == Some(&hex_digest(&image.unsigned.0))
                    && receipt.fee.0 <= intent.fee_cap.0,
                "Observation cannot replace release intent/image/fee cap"
            );
            hash(
                &receipt.network,
                receipt
                    .transaction
                    .as_deref()
                    .expect("Delivery transaction missing"),
                true,
            );
        } else {
            require!(
                receipt.operation == "holding"
                    && receipt.intent_hash.is_none()
                    && receipt.image_hash.is_none()
                    && receipt.transaction.is_none()
                    && receipt.fee.0 == 0,
                "Invalid custody observation purpose"
            );
        }
        let previous = self.observations.get(&receipt.event);
        if let Some(previous) = previous {
            if receipt == previous.latest {
                return previous.clone();
            }
            let old = &previous.latest;
            let conflict = receipt.block_height.0 < old.block_height.0
                || (receipt.block_height == old.block_height
                    && (receipt.block_hash != old.block_hash
                        || receipt.owner != old.owner
                        || receipt.operation != old.operation
                        || receipt.transaction != old.transaction
                        || receipt.image_hash != old.image_hash
                        || receipt.intent_hash != old.intent_hash
                        || receipt.fee != old.fee));
            if conflict || (previous.paused && !delivered) || (previous.delivered && !delivered) {
                let mut paused = previous.clone();
                paused.paused = true;
                self.observations
                    .insert(receipt.event.clone(), paused.clone());
                return paused;
            }
        }
        let state = ObservationState {
            paused: previous.is_some_and(|state| state.paused)
                || (!delivered && receipt.owner != asset.source),
            delivered,
            latest: receipt,
        };
        self.observations
            .insert(state.latest.event.clone(), state.clone());
        state
    }

    pub fn get_asset_observation(&self, event: String) -> Option<ObservationState> {
        self.observations.get(&event).cloned()
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    env::sha256(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
