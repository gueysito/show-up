//! Local ABI proof against the pinned near/mpc interface. No broadcaster or
//! production route is enabled. A failed callback never authorizes another call.
use crate::*;
use near_sdk::serde_json::{Value, json};
use near_sdk::{Gas, NearToken, Promise};

#[near]
impl Escrow {
    pub fn derive_custody_key(&mut self, event: String) -> Promise {
        let item = self.events.get(&event).expect("Unknown custody event");
        require!(
            item.status == "draft",
            "Bind custody key before publication"
        );
        let policy = item.terms.custody_proof_policy.as_ref().unwrap();
        let signer = policy.signer.as_ref().expect("Signing provider missing");
        let attempt = match self.custody_keys.get(&event) {
            Some(old) => {
                require!(
                    old.state == "unresolved" && old.attempt < 3,
                    "Key lookup already requested"
                );
                old.attempt + 1
            }
            None => 1,
        };
        let binding = CustodyKeyBinding {
            provider: signer.provider.clone(),
            domain_id: signer.domain_id,
            path: self.custody_path(&event),
            attempt,
            state: "pending".into(),
            public_key: None,
        };
        let args = json!({"path":binding.path,"predecessor":env::current_account_id(),"domain_id":binding.domain_id});
        self.custody_keys.insert(event.clone(), binding.clone());
        Promise::new(binding.provider)
            .function_call(
                "derived_public_key",
                bytes(&args),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_custody_key",
                bytes(&json!({"event":event,"attempt":attempt})),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            ))
    }

    #[private]
    pub fn on_custody_key(&mut self, event: String, attempt: u8) -> CustodyKeyBinding {
        require!(
            env::promise_results_count() == 1,
            "Key callback result count"
        );
        let policy = self
            .events
            .get(&event)
            .unwrap()
            .terms
            .custody_proof_policy
            .as_ref()
            .unwrap();
        let mut binding = self
            .custody_keys
            .get(&event)
            .expect("No key request")
            .clone();
        require!(
            binding.attempt == attempt && binding.state == "pending",
            "Stale key callback"
        );
        let key = env::promise_result_checked(0, 256)
            .ok()
            .and_then(|data| near_sdk::serde_json::from_slice::<String>(&data).ok())
            .filter(|key| key_address(key, &policy.network).as_ref() == Some(&policy.source));
        binding.state = if key.is_some() {
            "verified"
        } else {
            "unresolved"
        }
        .into();
        binding.public_key = key;
        self.custody_keys.insert(event, binding.clone());
        binding
    }

    pub fn get_custody_key(&self, event: String) -> Option<CustodyKeyBinding> {
        self.custody_keys.get(&event).cloned()
    }

    #[payable]
    pub fn request_custody_signature(&mut self, event: String) -> Promise {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Exactly one yocto required"
        );
        require!(
            !self
                .observations
                .get(&event)
                .is_some_and(|state| state.delivered),
            "Custody delivery already recorded"
        );
        let binding = self
            .custody_keys
            .get(&event)
            .expect("Derived custody key missing");
        let image = self
            .custody_images
            .get(&event)
            .expect("Typed custody image missing");
        require!(
            binding.state == "verified" && binding.path == image.path,
            "Custody key/path mismatch"
        );
        let image_hash = custody::image_hash(image);
        let request_id = format!("{event}:{image_hash}");
        require!(
            !self.custody_requests.contains_key(&request_id),
            "Image signature already requested; reconcile the original"
        );
        let payload = encode_hex(&image.payload.0);
        let payload_v2 = match image.scheme.as_str() {
            "Ecdsa" => {
                require!(
                    image.payload.0.len() == 32
                        && payload.as_str()
                            < "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
                    "Invalid ECDSA scalar payload"
                );
                json!({"Ecdsa":payload})
            }
            "Eddsa" => {
                require!(
                    (32..=1232).contains(&image.payload.0.len()),
                    "Invalid EdDSA message length"
                );
                json!({"Eddsa":payload})
            }
            _ => env::panic_str("Unsupported custody scheme"),
        };
        let request = CustodySigningRequest {
            event: event.clone(),
            image_hash: image_hash.clone(),
            provider: binding.provider.clone(),
            domain_id: binding.domain_id,
            path: image.path.clone(),
            scheme: image.scheme.clone(),
            payload: image.payload.clone(),
            public_key: binding.public_key.clone().unwrap(),
            state: "pending".into(),
            signature: None,
            signed_transaction: None,
            transaction: None,
        };
        let args = json!({"request":{"path":request.path,"domain_id":request.domain_id,"payload_v2":payload_v2}});
        self.custody_requests.insert(request_id, request.clone());
        Promise::new(request.provider)
            .function_call(
                "sign",
                bytes(&args),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(60),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_custody_signature",
                bytes(&json!({"event":event,"image_hash":image_hash})),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(30),
            ))
    }

    #[private]
    pub fn on_custody_signature(
        &mut self,
        event: String,
        image_hash: String,
    ) -> CustodySigningRequest {
        require!(
            env::promise_results_count() == 1,
            "Signing callback result count"
        );
        let id = format!("{event}:{image_hash}");
        let mut request = self
            .custody_requests
            .get(&id)
            .expect("No signing request")
            .clone();
        // An independently recovered signature may arrive before this callback.
        if request.state == "signed" {
            return request;
        }
        require!(
            request.state == "pending",
            "Signing callback already consumed"
        );
        let signature = env::promise_result_checked(0, 2048)
            .ok()
            .and_then(|data| near_sdk::serde_json::from_slice::<Value>(&data).ok())
            .and_then(|response| verified_signature(&request, &response));
        request.state = if signature.is_some() {
            "signed"
        } else {
            "unresolved"
        }
        .into();
        if let Some(signature) = signature {
            self.retain_custody_signature(&mut request, signature);
        }
        self.custody_requests.insert(id, request.clone());
        request
    }

    // Recovery supplies a valid response to the ORIGINAL request. It does not
    // send another provider call or accept a different path/payload/beneficiary.
    pub fn reconcile_custody_signature(
        &mut self,
        event: String,
        image_hash: String,
        response: Value,
    ) -> CustodySigningRequest {
        require!(bytes(&response).len() <= 2048, "Signing response bounds");
        let id = format!("{event}:{image_hash}");
        let mut request = self
            .custody_requests
            .get(&id)
            .expect("No original signing request")
            .clone();
        let signature = verified_signature(&request, &response)
            .expect("Signature does not match original request");
        if let Some(old) = &request.signature {
            require!(old.0 == signature, "Original signature already retained");
            return request;
        }
        request.state = "signed".into();
        self.retain_custody_signature(&mut request, signature);
        self.custody_requests.insert(id, request.clone());
        request
    }

    pub fn get_custody_signing_request(
        &self,
        event: String,
        image_hash: String,
    ) -> Option<CustodySigningRequest> {
        self.custody_requests
            .get(&format!("{event}:{image_hash}"))
            .cloned()
    }
}

impl Escrow {
    fn retain_custody_signature(&self, request: &mut CustodySigningRequest, signature: Vec<u8>) {
        let image = self
            .custody_history
            .get(&request.event)
            .unwrap()
            .iter()
            .find(|image| custody::image_hash(image) == request.image_hash)
            .expect("Known signing image missing");
        let (wire, transaction) = if request.scheme == "Ecdsa" {
            let wire = custody::signed_evm_image(image, &signature);
            let transaction = format!("0x{}", encode_hex(&env::keccak256(&wire)));
            (wire, transaction)
        } else {
            let transaction = bs58::encode(&signature).into_string();
            let mut wire = vec![1];
            wire.extend(&signature);
            wire.extend(&image.unsigned.0);
            (wire, transaction)
        };
        request.signature = Some(Base64VecU8(signature));
        request.signed_transaction = Some(Base64VecU8(wire));
        request.transaction = Some(transaction);
    }

    pub(crate) fn require_custody_transaction(
        &self,
        event: &String,
        image: &CustodyImage,
        transaction: &Option<String>,
    ) {
        if self
            .events
            .get(event)
            .unwrap()
            .terms
            .custody_proof_policy
            .as_ref()
            .unwrap()
            .signer
            .is_some()
        {
            let id = format!("{event}:{}", custody::image_hash(image));
            let request = self
                .custody_requests
                .get(&id)
                .expect("Original signature is not reconciled");
            require!(
                request.state == "signed"
                    && request.transaction.is_some()
                    && transaction == &request.transaction,
                "Observation transaction differs from the verified signing image"
            );
        }
    }
}

fn bytes(value: &Value) -> Vec<u8> {
    near_sdk::serde_json::to_vec(value).unwrap()
}
fn encode_hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn decode_hex(value: &str, length: usize) -> Option<Vec<u8>> {
    if value.len() != length * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
fn public_bytes(value: &str, prefix: &str, length: usize) -> Option<Vec<u8>> {
    let encoded = value.strip_prefix(prefix)?;
    if encoded.len() > 88 {
        return None;
    }
    let bytes = bs58::decode(encoded).into_vec().ok()?;
    (bytes.len() == length && bs58::encode(&bytes).into_string() == encoded).then_some(bytes)
}
fn key_address(key: &str, network: &str) -> Option<String> {
    if network == "solana" {
        Some(bs58::encode(public_bytes(key, "ed25519:", 32)?).into_string())
    } else {
        let key = public_bytes(key, "secp256k1:", 64)?;
        Some(format!("0x{}", encode_hex(&env::keccak256(&key)[12..])))
    }
}
fn verified_signature(request: &CustodySigningRequest, response: &Value) -> Option<Vec<u8>> {
    let object = response.as_object()?;
    if request.scheme == "Eddsa" {
        if object.len() != 2 || response.get("scheme")?.as_str()? != "Ed25519" {
            return None;
        }
        let encoded = response.get("signature")?.as_array()?;
        if encoded.len() != 64 {
            return None;
        }
        let signature: Vec<u8> = encoded
            .iter()
            .map(|value| u8::try_from(value.as_u64()?).ok())
            .collect::<Option<_>>()?;
        let key: [u8; 32] = public_bytes(&request.public_key, "ed25519:", 32)?
            .try_into()
            .ok()?;
        return env::ed25519_verify(
            signature.as_slice().try_into().ok()?,
            &request.payload.0,
            &key,
        )
        .then_some(signature);
    }
    if request.scheme != "Ecdsa"
        || object.len() != 4
        || response.get("scheme")?.as_str()? != "Secp256k1"
    {
        return None;
    }
    let r = response.get("big_r")?.as_object()?;
    let s = response.get("s")?.as_object()?;
    if r.len() != 1 || s.len() != 1 {
        return None;
    }
    let point = decode_hex(r.get("affine_point")?.as_str()?, 33)?;
    let scalar = decode_hex(s.get("scalar")?.as_str()?, 32)?;
    let recovery = u8::try_from(response.get("recovery_id")?.as_u64()?).ok()?;
    if recovery > 1 || point[0] != 2 + recovery {
        return None;
    }
    let mut signature = point[1..].to_vec();
    signature.extend(scalar);
    let expected = public_bytes(&request.public_key, "secp256k1:", 64)?;
    if env::ecrecover(&request.payload.0, &signature, recovery, true)?.as_slice() != expected {
        return None;
    }
    signature.push(recovery);
    Some(signature)
}
