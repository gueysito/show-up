mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use near_workspaces::Account;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
fn uuid(value: u64) -> String {
    let value = format!("{value:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &value[..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..]
    )
}
fn iso(value: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value.try_into().unwrap())
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

async fn prepared(f: &Fixture, number: u64, signer: &Account) -> Value {
    let (environment, chain_id, warning) = if f.domain == "showup.engineering.authorization.v1" {
        (
            "engineering",
            "testnet",
            "ENGINEERING TEST TOKENS ONLY. No mainnet funds or qualified funding route is authorized.",
        )
    } else {
        (
            "sandbox",
            "sandbox",
            "DISPOSABLE SANDBOX TOKENS ONLY. No real USDC or live funding route is authorized.",
        )
    };
    let mut auth = f.authorization(number, f.alice.id().as_str()).await;
    let issued = f.timestamp().await;
    let mut nonce = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut nonce)
        .unwrap();
    let source = json!({"network":"near","chainId":chain_id,"address":f.alice.id()});
    let terms = json!({"environment":environment,"manifest":f.manifest,"deployment":f.escrow.id(),
        "event":uuid(1),"rulesHash":f.rules_hash,"registration":uuid(number),"participant":uuid(number+1000),
        "timeZone":"America/Denver","source":source,"refund":source,"payout":source,
        "inputAsset":{"contract":f.token.id(),"decimals":6},"maximumInput":"5100000","principal":"5000000",
        "sourceGasMaximum":"1000000000000000000000000","routingFeeMaximum":"0","withdrawalFeeMaximum":"100000",
        "payoutMinimum":"1000000","quoteHash":id(90000),"quoteExpiresAt":issued+900_000,
        "registrationClosesAt":f.start,"authorizationExpiresAt":issued+900_000,"reservationExpiresAt":issued+300_000});
    let consent_id = uuid(number + 10000);
    let encoded_nonce = STANDARD.encode(nonce);
    let terms_hash = hash(&terms);
    let message = [
        "Showup event financial consent v1".to_string(),
        warning.into(),
        "Website: https://localhost:3443".into(),
        "Authorize only the event and limits below. A separate wallet transaction is required to transfer funds.".into(),
        "A signature, quote or reservation creates no funded seat. Enrollment requires actual attributable escrow.".into(),
        "Principal and payout limits use USDC atomic units (1 USDC = 1000000).".into(),
        "Maximum input uses the selected input asset units. Source gas maximum uses native atomic units.".into(),
        "Routing and withdrawal fee maxima use USDC atomic units. The platform fee is zero.".into(),
        "Principal returns less disclosed, authorized delivery fees. Unresolved amounts remain recoverable.".into(),
        format!("Consent: {consent_id}"),format!("Nonce: {encoded_nonce}"),format!("Issued: {}",iso(issued)),
        format!("Sign before: {}",iso(issued+300_000)),format!("Terms SHA-256: {terms_hash}"),terms.to_string(),
    ].join("\n");
    let consent = json!({"format":"showup.commitment.consent.v1","id":consent_id,"origin":"https://localhost:3443",
        "nonce":encoded_nonce,"issuedAt":issued,"signingExpiresAt":issued+300_000,"terms":terms,"termsHash":terms_hash,"message":message});
    // Only this generated, disposable sandbox account's in-memory signer is used.
    // No operator wallet/key file is read and no private key enters the export.
    let key: near_crypto::SecretKey = signer.secret_key().to_string().parse().unwrap();
    let mut payload = (2_u32.pow(31) + 413).to_le_bytes().to_vec();
    string(&mut payload, &message);
    payload.extend_from_slice(&nonce);
    string(&mut payload, "localhost:3443");
    payload.push(1);
    string(
        &mut payload,
        &format!("https://localhost:3443/account/commitments?consent={consent_id}"),
    );
    let near_crypto::Signature::ED25519(signature) = key.sign(&Sha256::digest(payload)) else {
        panic!("Generated Ed25519 signer required")
    };
    let proof = json!({"accountId":f.alice.id(),"publicKey":key.public_key().to_string(),"signature":STANDARD.encode(signature.to_bytes())});
    auth["wallet_tag"] = json!(hash(
        &json!({"format":"showup.funding.wallet.v1","deployment":f.escrow.id(),
        "environment":environment,"manifest":f.manifest,"event":f.event,"family":"near","address":f.alice.id()})
    ));
    auth["nonce"] = json!(hash(
        &json!({"format":"showup.commitment.nonce.v1","id":consent_id,"nonce":encoded_nonce})
    ));
    auth["expires_ms"] = json!(issued + 900_000);
    auth["reservation_ms"] = json!(issued + 300_000);
    auth["wallet_consent"] =
        json!(json!({"consent":consent,"proof":proof,"acceptedAt":issued}).to_string());
    auth
}

async fn exported(f: &Fixture, auth: &Value, stage: &str) -> Value {
    let block = f.worker.view_block().await.unwrap();
    let read = async |method: &str, args: Value| -> Value {
        f.escrow
            .view(method)
            .args_json(args)
            .block_hash(*block.hash())
            .await
            .unwrap()
            .json()
            .unwrap()
    };
    let balance: String = f
        .token
        .view("ft_balance_of")
        .args_json(json!({"account_id":f.escrow.id()}))
        .block_hash(*block.hash())
        .await
        .unwrap()
        .json()
        .unwrap();
    json!({"stage":stage,"context":{"environment":if f.domain=="showup.engineering.authorization.v1" {"engineering"} else {"sandbox"},"deployment":f.escrow.id(),"token":f.token.id(),
        "domain":f.domain,"manifest":f.manifest,"event":f.event,"rulesHash":f.rules_hash,
        "escrowCodeHash":bs58::encode(Sha256::digest(f.escrow.view_code().await.unwrap())).into_string(),
        "tokenCodeHash":bs58::encode(Sha256::digest(f.token.view_code().await.unwrap())).into_string(),"authorization":auth},
        "block":{"height":block.height().to_string(),"hash":block.hash().to_string(),"timestampMs":block.timestamp()/1_000_000},
        "views":{"event":read("get_event",json!({"event":f.event})).await,
            "registration":read("get_registration",json!({"registration":auth["registration"]})).await,
            "principal":read("get_liability",json!({"id":format!("{}:principal",auth["registration"].as_str().unwrap())})).await,
            "returned":read("get_liability",json!({"id":format!("{}:return",auth["registration"].as_str().unwrap())})).await,
            "accounting":read("accounting",json!({})).await,"tokenBalance":balance}})
}

#[tokio::test]
async fn native_financial_consent_survives_reservation_expiry_and_binds_actual_escrow_and_principal_return()
 {
    for engineering in [false, true] {
        let f = if engineering {
            Fixture::with_engineering_financial_consent().await
        } else {
            Fixture::with_financial_consent().await
        };
        let auth = prepared(&f, 800, &f.alice).await;
        f.bob
            .call(f.escrow.id(), "reserve")
            .args_json(json!({"authorization":auth,"proof":proof(&f.credential,&auth)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let mut vectors = vec![exported(&f, &auth, "reserved").await];
        f.advance(auth["reservation_ms"].as_u64().unwrap() + 1)
            .await;
        assert_eq!(f.fund(&f.alice, &auth, 5_000_000).await, "5000000");
        assert_eq!(
            f.view("get_registration", json!({"registration":id(800)}))
                .await["state"],
            "funded"
        );
        vectors.push(exported(&f, &auth, "funded_after_reservation").await);
        f.release(&auth).await;
        vectors.push(exported(&f, &auth, "released").await);
        f.bob
            .call(f.escrow.id(), "withdraw")
            .args_json(json!({"id":format!("{}:principal",id(800))}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(f.balance(f.alice.id().as_str()).await, 100_000_000);
        assert_eq!(f.liability(800, "principal").await["paid"], "5000000");
        vectors.push(exported(&f, &auth, "paid_principal").await);
        std::fs::write(
            if engineering {
                "/cache/engineering-financial-consent-public.json"
            } else {
                "/cache/financial-consent-public.json"
            },
            serde_json::to_vec_pretty(&vectors).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn credential_authority_cannot_substitute_wallet_financial_terms_or_actual_source_key() {
    let f = Fixture::with_financial_consent().await;
    let auth = prepared(&f, 900, &f.alice).await;
    let missing = f.authorization(901, f.alice.id().as_str()).await;
    assert_eq!(f.fund(&f.alice, &missing, 5_000_000).await, "0");
    let forged_key = prepared(&f, 902, &f.bob).await;
    assert_eq!(
        f.fund(&f.alice, &forged_key, 5_000_000).await,
        "0",
        "A signed key that does not control the actual source was credited"
    );
    for (field, value) in [
        ("payout", f.destination(f.bob.id().as_str())),
        ("refund", f.destination(f.bob.id().as_str())),
        ("source", f.destination(f.bob.id().as_str())),
        ("principal", json!("4000000")),
        ("fee_cap", json!("200000")),
        ("registration", json!(id(1900))),
        ("participant", json!(id(2900))),
        ("wallet_tag", json!(id(3900))),
        ("nonce", json!(id(4900))),
        (
            "expires_ms",
            json!(auth["expires_ms"].as_u64().unwrap() + 1),
        ),
        (
            "reservation_ms",
            json!(auth["reservation_ms"].as_u64().unwrap() - 1),
        ),
    ] {
        let mut changed = auth.clone();
        changed[field] = value;
        // Re-sign with the real credential authority. Only the source wallet's
        // original financial signature remains unchanged.
        assert_eq!(
            f.fund(&f.alice, &changed, 5_000_000).await,
            "0",
            "Authority substituted {field}"
        );
    }
    let mut envelope: Value =
        serde_json::from_str(auth["wallet_consent"].as_str().unwrap()).unwrap();
    envelope["consent"]["message"] = json!("Changed financial purpose");
    let mut changed = auth.clone();
    changed["wallet_consent"] = json!(envelope.to_string());
    assert_eq!(f.fund(&f.alice, &changed, 5_000_000).await, "0");
    assert_eq!(
        f.fund(&f.alice, &auth, 5_100_001).await,
        "0",
        "Amount beyond the wallet-approved maximum was credited"
    );
    assert_eq!(f.balance(f.alice.id().as_str()).await, 100_000_000);
    assert!(
        f.view("get_registration", json!({"registration":id(900)}))
            .await
            .is_null()
    );
    assert_eq!(f.fund(&f.alice, &auth, 5_050_000).await, "5050000");
    assert_eq!(f.liability(900, "return").await["total"], "50000");
    f.fund(&f.alice, &auth, 5_000_000).await;
    assert_eq!(f.liability(900, "return").await["total"], "5050000");
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["funded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
