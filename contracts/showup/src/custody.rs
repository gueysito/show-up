//! Sandbox P4 construction and irreversible intent proof; no MPC request or
//! broadcaster authority. The prescribed beneficiary is a fixture, not a winner.
use crate::*;
use near_sdk::serde_json::json;

const CORE: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const COMPUTE: &str = "ComputeBudget111111111111111111111111111111";
const SYSTEM: &str = "11111111111111111111111111111111";

#[near]
impl Escrow {
    /// Stand-in for a future canonical claim/return decision. Private sandbox
    /// fixture access does not qualify production winner selection or custody.
    #[private]
    pub fn lock_custody_intent(&mut self, event: String, operation: String) -> CustodyIntent {
        if let Some(intent) = self.custody_intents.get(&event) {
            require!(
                intent.operation == operation,
                "Opposite custody intent forbidden"
            );
            return intent.clone();
        }
        let item = self.events.get(&event).expect("Unknown event");
        let policy = item
            .terms
            .custody_proof_policy
            .as_ref()
            .expect("Custody proof policy missing");
        let draw = self.draws.get(&event);
        let permitted = match operation.as_str() {
            "delivery" => {
                item.status == "closed" && draw.is_some_and(|draw| draw.state == "verified")
            }
            "return" => {
                item.status == "cancelled"
                    || item.status == "aborted"
                    || (item.status == "closed"
                        && draw.is_some_and(|draw| draw.state == "timed_out"))
            }
            _ => false,
        };
        require!(permitted, "Canonical fixture decision missing");
        let intent = CustodyIntent {
            deployment: env::current_account_id().to_string(),
            environment: "engineering".into(),
            manifest: "showup-engineering-2026-11-02-v1".into(),
            network: policy.network.clone(),
            event: event.clone(),
            rules_hash: item.terms.rules_hash.clone(),
            payout: digest(
                format!(
                    "{}:custody:{}:{event}",
                    self.domain,
                    env::current_account_id()
                )
                .as_bytes(),
            ),
            recipient: if operation == "delivery" {
                policy.beneficiary.clone()
            } else {
                policy.contributor.clone()
            },
            operation,
            collection: policy.collection.clone(),
            asset: policy.asset.clone(),
            source: policy.source.clone(),
            fee_cap: policy.fee_cap,
        };
        self.custody_intents.insert(event, intent.clone());
        intent
    }

    #[private]
    pub fn prepare_evm_custody(
        &mut self,
        event: String,
        envelope: EvmCustodyEnvelope,
    ) -> CustodyImage {
        let intent = self
            .custody_intents
            .get(&event)
            .expect("Lock custody intent first");
        let chain = match intent.network.as_str() {
            "base" => 84532u128,
            "ethereum" => 11155111u128,
            _ => env::panic_str("Wrong custody family"),
        };
        require!(
            envelope.nonce <= 9_007_199_254_740_991
                && (21_000..=300_000).contains(&envelope.gas_limit),
            "Invalid nonce/gas"
        );
        require!(
            envelope.max_fee_per_gas.0 > 0
                && envelope.max_priority_fee_per_gas.0 <= envelope.max_fee_per_gas.0
                && u128::from(envelope.gas_limit)
                    .checked_mul(envelope.max_fee_per_gas.0)
                    .is_some_and(|fee| fee <= intent.fee_cap.0),
            "Fee cap exceeded"
        );
        let mut data = vec![0x42, 0x84, 0x2e, 0x0e];
        data.extend([0u8; 12]);
        data.extend(evm_address(&intent.source));
        data.extend([0u8; 12]);
        data.extend(evm_address(&intent.recipient));
        data.extend(hex_bytes(&intent.asset, 32));
        let fields = [
            rlp_int(chain),
            rlp_int(u128::from(envelope.nonce)),
            rlp_int(envelope.max_priority_fee_per_gas.0),
            rlp_int(envelope.max_fee_per_gas.0),
            rlp_int(u128::from(envelope.gas_limit)),
            rlp_bytes(&evm_address(&intent.collection)),
            rlp_int(0),
            rlp_bytes(&data),
            rlp_list(&[]),
        ];
        let mut unsigned = vec![2];
        unsigned.extend(rlp_list(&fields));
        let payload = env::keccak256(&unsigned);
        self.remember_image(event, &envelope, "Ecdsa", unsigned, payload)
    }

    #[private]
    pub fn prepare_solana_custody(
        &mut self,
        event: String,
        envelope: SolanaCustodyEnvelope,
    ) -> CustodyImage {
        let intent = self
            .custody_intents
            .get(&event)
            .expect("Lock custody intent first");
        require!(intent.network == "solana", "Wrong custody family");
        require!(
            (1..=200_000).contains(&envelope.compute_units)
                && envelope.estimated_fee.0 > 0
                && envelope.estimated_fee.0 <= intent.fee_cap.0,
            "Invalid Solana fee context"
        );
        let keys = [
            intent.source.as_str(),
            intent.asset.as_str(),
            intent.collection.as_str(),
            intent.recipient.as_str(),
            SYSTEM,
            CORE,
            COMPUTE,
        ];
        let mut unsigned = vec![1, 0, 5, 7];
        for key in keys {
            unsigned.extend(solana_key(key));
        }
        unsigned.extend(solana_key(&envelope.blockhash));
        unsigned.extend([3, 6, 0, 5, 2]);
        unsigned.extend(envelope.compute_units.to_le_bytes());
        unsigned.extend([6, 0, 9, 3]);
        unsigned.extend([0u8; 8]);
        unsigned.extend([5, 7, 1, 2, 0, 0, 3, 4, 5, 2, 14, 0]);
        self.remember_image(event, &envelope, "Eddsa", unsigned.clone(), unsigned)
    }

    pub fn get_custody_intent(&self, event: String) -> Option<CustodyIntent> {
        self.custody_intents.get(&event).cloned()
    }
    pub fn get_custody_image(&self, event: String) -> Option<CustodyImage> {
        self.custody_images.get(&event).cloned()
    }
}

impl Escrow {
    fn remember_image<T: near_sdk::serde::Serialize>(
        &mut self,
        event: String,
        envelope: &T,
        scheme: &str,
        unsigned: Vec<u8>,
        payload: Vec<u8>,
    ) -> CustodyImage {
        let intent = self.custody_intents.get(&event).unwrap();
        let envelope_hash = digest(&canonical::bytes(envelope));
        if let Some(image) = self.custody_images.get(&event) {
            require!(
                image.envelope_hash == envelope_hash && image.scheme == scheme,
                "Original signing image unresolved"
            );
            return image.clone();
        }
        let descriptor = json!({"deployment":intent.deployment,"environment":intent.environment,"network":intent.network,
            "event":intent.event,"collection":intent.collection,"asset":intent.asset});
        let image = CustodyImage {
            intent_hash: digest(&canonical::bytes(intent)),
            path: format!(
                "showup.v1/engineering/{}/{}",
                intent.network,
                digest(&canonical::bytes(&descriptor))
            ),
            scheme: scheme.into(),
            unsigned: Base64VecU8(unsigned),
            payload: Base64VecU8(payload),
            envelope_hash,
        };
        self.custody_images.insert(event, image.clone());
        image
    }
}

pub(crate) fn validate_policy(policy: &CustodyProofPolicy) {
    require!(
        policy.fee_cap.0 > 0
            && policy.beneficiary != policy.contributor
            && policy.source != policy.beneficiary
            && policy.source != policy.contributor,
        "Invalid custody policy"
    );
    match policy.network.as_str() {
        "base" | "ethereum" => {
            for address in [
                &policy.collection,
                &policy.source,
                &policy.beneficiary,
                &policy.contributor,
            ] {
                evm_address(address);
            }
            hex_bytes(&policy.asset, 32);
        }
        "solana" => {
            let keys = [
                policy.source.as_str(),
                policy.asset.as_str(),
                policy.collection.as_str(),
                policy.beneficiary.as_str(),
                SYSTEM,
                CORE,
                COMPUTE,
            ];
            for (index, key) in keys.iter().enumerate() {
                solana_key(key);
                require!(!keys[..index].contains(key), "Duplicate custody role");
            }
            solana_key(&policy.contributor);
            require!(
                ![
                    policy.source.as_str(),
                    policy.asset.as_str(),
                    policy.collection.as_str(),
                    SYSTEM,
                    CORE,
                    COMPUTE
                ]
                .contains(&policy.contributor.as_str()),
                "Invalid return role"
            );
        }
        _ => env::panic_str("Unsupported custody family"),
    }
}
fn evm_address(value: &str) -> Vec<u8> {
    let bytes = hex_bytes(value, 20);
    require!(bytes.iter().any(|byte| *byte != 0), "Zero address");
    bytes
}
fn hex_bytes(value: &str, length: usize) -> Vec<u8> {
    require!(
        value.len() == 2 + length * 2
            && value.starts_with("0x")
            && value[2..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "Invalid canonical hex"
    );
    value.as_bytes()[2..]
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn solana_key(value: &str) -> Vec<u8> {
    require!((32..=44).contains(&value.len()), "Invalid Solana key");
    let bytes = bs58::decode(value).into_vec().expect("Invalid Base58");
    require!(
        bytes.len() == 32 && bs58::encode(&bytes).into_string() == value,
        "Noncanonical public key"
    );
    bytes
}
fn digest(bytes: &[u8]) -> String {
    env::sha256(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn rlp_int(value: u128) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len());
    rlp_bytes(&bytes[first..])
}
fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 128 {
        return bytes.to_vec();
    }
    let mut output = rlp_prefix(bytes.len(), 0x80);
    output.extend(bytes);
    output
}
fn rlp_list(fields: &[Vec<u8>]) -> Vec<u8> {
    let bytes: Vec<u8> = fields.concat();
    let mut output = rlp_prefix(bytes.len(), 0xc0);
    output.extend(bytes);
    output
}
fn rlp_prefix(length: usize, base: u8) -> Vec<u8> {
    if length < 56 {
        return vec![base + u8::try_from(length).unwrap()];
    }
    let bytes = length.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap();
    let suffix = &bytes[first..];
    let mut prefix = vec![base + 55 + u8::try_from(suffix.len()).unwrap()];
    prefix.extend(suffix);
    prefix
}
