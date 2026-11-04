//! Source-wallet financial proof. Eligibility and actual token receipt are separate.
use crate::financial::{base64, object, text};
use crate::*;
use near_sdk::serde_json::{Map, Value};

fn hex(value: &str) -> Vec<u8> {
    require!(
        value.len().is_multiple_of(2) && value.len() <= 130,
        "Financial hex bounds"
    );
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit =
                |byte: u8| (byte as char).to_digit(16).expect("Invalid financial hex") as u8;
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect()
}
fn key(value: &str) -> [u8; 32] {
    require!(value.len() <= 44, "Financial public key bounds");
    let bytes = bs58::decode(value)
        .into_vec()
        .expect("Invalid financial public key");
    require!(
        bs58::encode(&bytes).into_string() == value,
        "Noncanonical financial public key"
    );
    bytes.try_into().expect("Financial public key length")
}

pub(crate) fn verify(
    auth: &Authorization,
    consent: &Map<String, Value>,
    proof: &Value,
    message: &str,
    origin: &str,
) -> Option<[u8; 32]> {
    match auth.source.network.as_str() {
        "near" => {
            let proof = object(proof, "accountId,publicKey,signature");
            require!(
                text(&proof["accountId"]) == auth.source.address,
                "Financial signer account changed"
            );
            let public_key = key(text(&proof["publicKey"])
                .strip_prefix("ed25519:")
                .expect("Financial Ed25519 key required"));
            let payload = near_sdk::borsh::to_vec(&(
                2_u32.pow(31) + 413,
                message,
                base64::<32>(&consent["nonce"]),
                origin.strip_prefix("https://").unwrap(),
                Some(format!(
                    "{origin}/account/commitments?consent={}",
                    text(&consent["id"])
                )),
            ))
            .unwrap();
            require!(
                env::ed25519_verify(
                    &base64::<64>(&proof["signature"]),
                    env::sha256(payload),
                    &public_key
                ),
                "Invalid source financial signature"
            );
            Some(public_key)
        }
        "solana" => {
            let proof = object(proof, "signature");
            require!(
                env::ed25519_verify(
                    &base64::<64>(&proof["signature"]),
                    message.as_bytes(),
                    &key(&auth.source.address)
                ),
                "Invalid source financial signature"
            );
            None
        }
        "base" | "ethereum" => {
            let proof = object(proof, "signature");
            require!(
                auth.source.address == auth.source.address.to_ascii_lowercase(),
                "Noncanonical financial address"
            );
            let address = hex(auth
                .source
                .address
                .strip_prefix("0x")
                .expect("Financial EVM address required"));
            require!(
                address.len() == 20 && address != [0u8; 20],
                "Financial EVM address length"
            );
            let mut signature = hex(text(&proof["signature"])
                .strip_prefix("0x")
                .expect("Financial EVM signature required"));
            let recovery = match signature.len() {
                64 => {
                    let parity = signature[32] >> 7;
                    signature[32] &= 127;
                    parity
                }
                65 => match signature.pop().unwrap() {
                    value @ 0..=1 => value,
                    value @ 27..=28 => value - 27,
                    _ => env::panic_str("Invalid financial EVM parity"),
                },
                _ => env::panic_str("Financial EVM signature length"),
            };
            let payload = format!("\x19Ethereum Signed Message:\n{}{message}", message.len());
            let public_key = env::ecrecover(
                &env::keccak256(payload.as_bytes()),
                &signature,
                recovery,
                true,
            )
            .expect("Invalid source financial signature");
            require!(
                env::keccak256(public_key)[12..] == address,
                "Financial signer address changed"
            );
            None
        }
        _ => env::panic_str("Unsupported financial wallet family"),
    }
}
