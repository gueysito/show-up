use crate::*;
use near_sdk::json_types::Base64VecU8;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NftPrize {
    pub collection: String,
    pub token_id: U128,
    pub contributor: String,
    #[serde(default)]
    pub custody: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub deriving: bool,
    #[serde(default)]
    pub held: bool,
    #[serde(default)]
    pub request: Option<NftRequest>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NftRequest {
    pub recipient: String,
    pub payload: String,
    pub unsigned_transaction: Base64VecU8,
    pub state: String,
    pub signature: Option<String>,
    pub attempt: u32,
}

impl NftPrize {
    pub(crate) fn validate_new(&self) {
        evm_address(&self.collection);
        evm_address(&self.contributor);
        require!(
            self.custody.is_none()
                && self.public_key.is_none()
                && !self.deriving
                && !self.held
                && self.request.is_none(),
            "New NFT state only"
        );
    }
}

#[near]
impl EscrowV1 {
    pub fn derive_nft_custody(&mut self, event: String) -> Promise {
        self.only_owner();
        let item = self.events.get_mut(&event).expect("Unknown event");
        require!(item.status == "draft", "Draft only");
        let nft = item.nft.as_mut().expect("No NFT");
        require!(!nft.deriving && nft.custody.is_none(), "Already requested");
        nft.deriving = true;
        Promise::new(self.signer.clone()).function_call("derived_public_key",
            bytes(&json!({"path":path(&event),"predecessor":env::current_account_id(),"domain_id":0})),
            NearToken::from_yoctonear(0), Gas::from_tgas(15))
            .then(Promise::new(env::current_account_id()).function_call("on_nft_key", bytes(&json!({"event":event})), NearToken::from_yoctonear(0), Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_nft_key(&mut self, event: String) -> Option<String> {
        require!(env::promise_results_count() == 1, "Invalid callback");
        let nft = self.events.get_mut(&event).unwrap().nft.as_mut().unwrap();
        require!(nft.deriving && nft.custody.is_none(), "Stale callback");
        nft.deriving = false;
        let encoded = env::promise_result_checked(0, 256)
            .ok()
            .and_then(|data| near_sdk::serde_json::from_slice::<String>(&data).ok());
        let key = encoded.as_ref().and_then(|text| {
            text.strip_prefix("secp256k1:")
                .and_then(|s| bs58::decode(s).into_vec().ok())
        });
        if let Some(key) = key.filter(|value| value.len() == 64) {
            nft.custody = Some(format!("0x{}", hex(&env::keccak256(key)[12..])));
            nft.public_key = encoded;
        }
        nft.custody.clone()
    }

    /// Operator confirms an actual Ethereum ownerOf read before publication.
    pub fn confirm_nft_custody(&mut self, event: String) {
        self.only_owner();
        let item = self.events.get_mut(&event).expect("Unknown event");
        require!(
            item.status == "draft" || item.status == "cancelled",
            "Draft/cancelled only"
        );
        let nft = item.nft.as_mut().expect("No NFT");
        require!(nft.custody.is_some(), "Derived custody missing");
        nft.held = true;
    }

    #[payable]
    pub fn release_nft(
        &mut self,
        event: String,
        nonce: u64,
        gas_limit: u64,
        priority_fee: U128,
        max_fee: U128,
    ) -> Promise {
        self.only_owner();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "One yocto required"
        );
        require!(
            (50_000..=250_000).contains(&gas_limit)
                && priority_fee.0 <= max_fee.0
                && max_fee.0 > 0
                && max_fee
                    .0
                    .checked_mul(gas_limit as u128)
                    .is_some_and(|cost| cost <= 100_000_000_000_000),
            "NFT gas limit"
        );
        let item = self.events.get(&event).expect("Unknown event").clone();
        require!(
            item.status == "settled" || item.status == "cancelled",
            "Event not closed"
        );
        let nft = item.nft.expect("No NFT");
        require!(
            nft.held && nft.request.is_none(),
            "NFT not held/already requested"
        );
        let recipient = item
            .winner
            .as_ref()
            .filter(|_| item.status == "settled")
            .map(|id| {
                self.registrations
                    .get(id)
                    .unwrap()
                    .ethereum
                    .clone()
                    .unwrap()
            })
            .unwrap_or_else(|| nft.contributor.clone());
        let from = evm_address(nft.custody.as_ref().expect("Custody missing"));
        let to = evm_address(&recipient);
        let mut calldata = vec![0x42, 0x84, 0x2e, 0x0e]; // ERC-721 safeTransferFrom(address,address,uint256).
        calldata.extend_from_slice(&[0; 12]);
        calldata.extend_from_slice(&from);
        calldata.extend_from_slice(&[0; 12]);
        calldata.extend_from_slice(&to);
        calldata.extend_from_slice(&[0; 16]);
        calldata.extend_from_slice(&nft.token_id.0.to_be_bytes());
        let fields = [
            rlp(&integer(1)),
            rlp(&integer(nonce as u128)),
            rlp(&integer(priority_fee.0)),
            rlp(&integer(max_fee.0)),
            rlp(&integer(gas_limit as u128)),
            rlp(&evm_address(&nft.collection)),
            rlp(&[]),
            rlp(&calldata),
            vec![0xc0],
        ]
        .concat();
        let mut unsigned = vec![2];
        unsigned.extend(rlp_list(&fields));
        let payload = hex(&env::keccak256(&unsigned));
        let request = NftRequest {
            recipient,
            payload: payload.clone(),
            unsigned_transaction: Base64VecU8(unsigned),
            state: "pending".into(),
            signature: None,
            attempt: 1,
        };
        self.events
            .get_mut(&event)
            .unwrap()
            .nft
            .as_mut()
            .unwrap()
            .request = Some(request);
        self.sign_nft(&event, &payload, 1)
    }

    /// Retry only the original transaction, never a different nonce, fee or recipient.
    #[payable]
    pub fn retry_nft_signature(&mut self, event: String) -> Promise {
        self.only_owner();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "One yocto required"
        );
        let request = self
            .events
            .get_mut(&event)
            .expect("Unknown event")
            .nft
            .as_mut()
            .expect("No NFT")
            .request
            .as_mut()
            .expect("No original request");
        require!(
            request.state == "unresolved" && request.attempt < 3,
            "Not retryable/attempt limit"
        );
        request.attempt += 1;
        request.state = "pending".into();
        let payload = request.payload.clone();
        let attempt = request.attempt;
        self.sign_nft(&event, &payload, attempt)
    }

    #[private]
    pub fn on_nft_signature(&mut self, event: String, attempt: u32) -> Option<String> {
        require!(env::promise_results_count() == 1, "Invalid callback");
        let nft = self.events.get_mut(&event).unwrap().nft.as_mut().unwrap();
        let request = nft.request.as_mut().unwrap();
        require!(request.attempt == attempt, "Stale callback");
        if request.state == "signed" {
            return request.signature.clone();
        }
        require!(request.state == "pending", "Stale callback");
        request.signature = env::promise_result_checked(0, 2048)
            .ok()
            .and_then(|data| near_sdk::serde_json::from_slice::<Value>(&data).ok())
            .filter(|value| {
                verified_signature(value, nft.public_key.as_ref().unwrap(), &request.payload)
            })
            .map(|value| value.to_string());
        request.state = if request.signature.is_some() {
            "signed"
        } else {
            "unresolved"
        }
        .into();
        request.signature.clone()
    }

    /// Accept only a valid signature of the original immutable payload; no new sign call.
    pub fn reconcile_nft_signature(&mut self, event: String, response: Value) -> bool {
        require!(
            bytes(&response).len() <= 2048,
            "Signature response too large"
        );
        let nft = self
            .events
            .get_mut(&event)
            .expect("Unknown event")
            .nft
            .as_mut()
            .expect("No NFT");
        let request = nft.request.as_mut().expect("No original request");
        require!(
            verified_signature(
                &response,
                nft.public_key.as_ref().unwrap(),
                &request.payload
            ),
            "Invalid original signature"
        );
        request.signature = Some(response.to_string());
        request.state = "signed".into();
        true
    }
}

impl EscrowV1 {
    fn sign_nft(&self, event: &str, payload: &str, attempt: u32) -> Promise {
        Promise::new(self.signer.clone()).function_call("sign",
            bytes(&json!({"request":{"path":path(event),"domain_id":0,"payload_v2":{"Ecdsa":payload}}})),
            NearToken::from_yoctonear(1), Gas::from_tgas(60))
            .then(Promise::new(env::current_account_id()).function_call("on_nft_signature", bytes(&json!({"event":event,"attempt":attempt})), NearToken::from_yoctonear(0), Gas::from_tgas(15)))
    }
}

fn path(event: &str) -> String {
    format!("showup:v1:{event}")
}
fn verified_signature(response: &Value, public_key: &str, payload: &str) -> bool {
    let Some(recovery) = response
        .get("recovery_id")
        .and_then(Value::as_u64)
        .filter(|v| *v <= 1)
    else {
        return false;
    };
    if response["scheme"] != "Secp256k1" {
        return false;
    }
    let Some(point) = response["big_r"]["affine_point"]
        .as_str()
        .and_then(|v| decode_hex(v, 33))
    else {
        return false;
    };
    let Some(scalar) = response["s"]["scalar"]
        .as_str()
        .and_then(|v| decode_hex(v, 32))
    else {
        return false;
    };
    let Some(hash) = decode_hex(payload, 32) else {
        return false;
    };
    let Some(expected) = public_key
        .strip_prefix("secp256k1:")
        .and_then(|v| bs58::decode(v).into_vec().ok())
    else {
        return false;
    };
    if point[0] != 2 + recovery as u8 {
        return false;
    }
    let mut signature = point[1..].to_vec();
    signature.extend(scalar);
    env::ecrecover(&hash, &signature, recovery as u8, true)
        .is_some_and(|key| key.as_slice() == expected)
}
fn decode_hex(value: &str, length: usize) -> Option<Vec<u8>> {
    if value.len() != length * 2 || !value.is_ascii() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect()
}
pub(crate) fn evm_address(value: &str) -> Vec<u8> {
    require!(
        value.starts_with("0x")
            && value.len() == 42
            && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit),
        "Invalid Ethereum address"
    );
    let result: Vec<_> = (2..42)
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect();
    require!(
        result.iter().any(|byte| *byte != 0),
        "Zero Ethereum address"
    );
    result
}
fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn integer(value: u128) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    bytes
        .iter()
        .position(|byte| *byte != 0)
        .map_or_else(Vec::new, |index| bytes[index..].to_vec())
}
fn prefix(length: usize, short: u8, long: u8) -> Vec<u8> {
    if length < 56 {
        vec![short + length as u8]
    } else {
        let size = integer(length as u128);
        let mut result = vec![long + size.len() as u8];
        result.extend(size);
        result
    }
}
fn rlp(value: &[u8]) -> Vec<u8> {
    if value.len() == 1 && value[0] < 128 {
        return value.to_vec();
    }
    let mut result = prefix(value.len(), 0x80, 0xb7);
    result.extend_from_slice(value);
    result
}
fn rlp_list(value: &[u8]) -> Vec<u8> {
    let mut result = prefix(value.len(), 0xc0, 0xf7);
    result.extend_from_slice(value);
    result
}
