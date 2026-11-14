//! Provider authentication for G1. This read-only inspection grants no route,
//! wallet, deadline or payment authority. Spending must bind its own stored terms.
use crate::*;
use near_sdk::serde_json::{Value, json};

const PROVIDER_KEY: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

pub(crate) fn authenticate(
    response: &str,
    key: &[u8; 32],
) -> (Value, routing_quote_fields::SelectedQuote, String) {
    require!(response.len() <= 32_768, "Provider quote byte limit");
    let parsed: Value = near_sdk::serde_json::from_str(response).expect("Invalid provider JSON");
    let selected = routing_quote_fields::quote_fields(&parsed);
    let digest = env::sha256(canonical::bytes(&selected.fields));
    let message = bs58::encode(&digest).into_string();
    let encoded = parsed["signature"]
        .as_str()
        .and_then(|value| value.strip_prefix("ed25519:"))
        .expect("Provider Ed25519 signature required");
    require!(encoded.len() <= 88, "Provider signature byte limit");
    let signature = bs58::decode(encoded)
        .into_vec()
        .expect("Invalid provider signature encoding");
    require!(
        bs58::encode(&signature).into_string() == encoded,
        "Noncanonical provider signature"
    );
    let signature: [u8; 64] = signature.try_into().expect("Provider signature length");
    require!(
        env::ed25519_verify(&signature, message.as_bytes(), key),
        "Invalid provider quote signature"
    );
    let hash = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    (parsed, selected, hash)
}
pub(crate) fn plain_route(request: &near_sdk::serde_json::Map<String, Value>) {
    for key in [
        "referral",
        "virtualChainRecipient",
        "virtualChainRefundRecipient",
    ] {
        require!(!request.contains_key(key), "Unsupported routing modifier");
    }
    // The API inserts this observed service-fee entry even for appFees: [].
    // Metadata is unsigned: it is a compatibility check, not fee-distribution
    // proof. Signed input/net bounds enforce the actual maximum cost.
    require!(request.get("appFees").is_none_or(|v|v.as_array().is_some_and(Vec::is_empty)
        || v==&json!([{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":1}])),
        "Unapproved routing fee metadata");
    require!(
        request
            .get("rebates")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)),
        "Rebates are not authorized"
    );
    require!(
        request.get("insured").is_none_or(|v| v == false)
            && request.get("depositMode").is_none_or(|v| v == "SIMPLE"),
        "Unsupported routing option"
    );
}

#[near]
impl Escrow {
    /// Authenticate historical provider bytes without calling a provider or
    /// changing state. Freshness, expected request and fee consent are separate.
    pub fn inspect_routing_quote(&self, response: String) -> Value {
        let key: [u8; 32] = bs58::decode(PROVIDER_KEY)
            .into_vec()
            .unwrap()
            .try_into()
            .unwrap();
        let (_, selected, _) = authenticate(&response, &key);
        let message = bs58::encode(env::sha256(canonical::bytes(&selected.fields))).into_string();
        json!({
            "format":"showup.routing.quote-inspection.v1",
            "provider_message":message,
            "selected":selected.fields,
            "request_deadline":selected.request_deadline,
            "request_deadline_authenticated":selected.request_deadline_authenticated,
            "freshness_checked":false,
            "expected_request_checked":false,
            "funding_allowed":false
        })
    }
}
