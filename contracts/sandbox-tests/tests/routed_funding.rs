mod common;
#[path = "../../showup/src/routing_quote_fields.rs"]
mod quote_fields;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use near_crypto::{KeyType, SecretKey};
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn uuid(value: u64) -> String {
    format!("00000000-0000-0000-0000-{value:012x}")
}
fn iso(value: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value.try_into().unwrap())
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn signature(key: &SecretKey, bytes: &[u8]) -> Vec<u8> {
    bs58::decode(key.sign(bytes).to_string().split_once(':').unwrap().1)
        .into_vec()
        .unwrap()
}
fn sign_quote(quote: &mut Value, key: &SecretKey) -> String {
    let selection = quote_fields::quote_fields(quote);
    assert!(!selection.request_deadline_authenticated);
    assert_eq!(
        selection.request_deadline,
        quote["quoteRequest"]["deadline"]
    );
    let selected = json!(selection.fields);
    let message = bs58::encode(Sha256::digest(selected.to_string())).into_string();
    quote["signature"] = json!(key.sign(message.as_bytes()).to_string());
    hash(&selected)
}

// Generated in-memory source/provider keys and disposable token receipts only.
// No operator credential file, public signer or real routing service is used.
async fn fixture(network: &str) -> (Fixture, Value, Value, SecretKey) {
    fixture_with_returns(network, false).await
}

async fn fixture_with_returns(network: &str, returns: bool) -> (Fixture, Value, Value, SecretKey) {
    let mut f = Fixture::new(1, "online", 0).await;
    let provider = SecretKey::from_random(KeyType::ED25519);
    let assets = json!([
        {"network":"near","chain_id":"sandbox","contract":f.token.id(),"route_asset":format!("nep141:{}",f.token.id())},
        {"network":"base","chain_id":"84532","contract":"0x036cbd53842c5426634e7929541ec2318f3dcf7e","route_asset":"nep141:base-usdc.fixture"},
        {"network":"ethereum","chain_id":"11155111","contract":"0x1c7d4b196cb0c7b01d743fbc6116a902379c7238","route_asset":"nep141:ethereum-usdc.fixture"},
        {"network":"solana","chain_id":"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG","contract":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","route_asset":"nep141:solana-usdc.fixture"}
    ]);
    let mut event = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
    f.event = id(2);
    event["event"] = json!(f.event);
    event["wallet_consent_origin"] = json!("https://localhost:3443");
    event["routing_policy"] = json!({"sender":f.bob.id(),"quote_key":STANDARD.encode(provider.public_key().key_data()),"assets":assets});
    if returns {
        event["routing_policy"]["returns"] = json!({"max_attempts":3,"observer":{
            "key":STANDARD.encode(f.observer.verifying_key().to_bytes()),"profile_hash":id(9600),
            "sources":["fixture-one","fixture-two"],"operators":["fixture-operator-one","fixture-operator-two"]}});
    }
    f.rules_hash = f.rules_commitment(&event);
    event["rules_hash"] = json!(f.rules_hash);
    f.escrow
        .call("create_event")
        .args_json(json!({"terms":event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.host
        .call(f.escrow.id(), "publish")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let source_key = if network == "near" {
        f.alice.secret_key().to_string().parse().unwrap()
    } else {
        SecretKey::from_random(if network == "solana" {
            KeyType::ED25519
        } else {
            KeyType::SECP256K1
        })
    };
    let address = match network {
        "near" => f.alice.id().to_string(),
        "solana" => bs58::encode(source_key.public_key().key_data()).into_string(),
        _ => format!(
            "0x{}",
            hex(&Keccak256::digest(source_key.public_key().key_data())[12..])
        ),
    };
    let selected = assets
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["network"] == network)
        .unwrap();
    let issued = f.timestamp().await;
    let mut auth = f.authorization(100, &address).await;
    auth["source"] = json!({"network":network,"asset":selected["contract"],"address":address});
    auth["refund"] = auth["source"].clone();
    auth["payout"] = if returns {
        auth["source"].clone()
    } else {
        f.destination(f.alice.id().as_str())
    };
    let message = json!({"kind":"routed_commitment","registration":auth["registration"]});
    let mut quote = json!({"timestamp":iso(issued),"quoteRequest":{"dry":false,"swapType":"EXACT_OUTPUT","slippageTolerance":100,
        "originAsset":selected["route_asset"],"depositType":"ORIGIN_CHAIN","destinationAsset":format!("nep141:{}",f.token.id()),
        "amount":"5000000","refundTo":address,"refundType":"ORIGIN_CHAIN","recipient":f.escrow.id(),"recipientType":"DESTINATION_CHAIN",
        "deadline":iso(issued+900_000),"quoteWaitingTimeMs":3000,"customRecipientMsg":message.to_string()},
        "quote":{"amountIn":"5050000","minAmountIn":"5010000","amountOut":"5000000","minAmountOut":"5000000",
        "amountInFormatted":"5.05","amountInUsd":"5.05","amountOutFormatted":"5","amountOutUsd":"5",
        "depositAddress":address,"deadline":iso(issued+600_000),"refundFee":"0","withdrawFee":"0"}});
    let quote_hash = sign_quote(&mut quote, &provider);
    let wallet = json!({"network":network,"chainId":selected["chain_id"],"address":address});
    let payout = if returns {
        wallet.clone()
    } else {
        json!({"network":"near","chainId":"sandbox","address":f.alice.id()})
    };
    let terms = json!({"environment":"sandbox","manifest":f.manifest,"deployment":f.escrow.id(),"event":uuid(2),
        "rulesHash":f.rules_hash,"registration":uuid(100),"participant":uuid(1100),"timeZone":"America/Denver",
        "source":wallet,"refund":wallet,"payout":payout,
        "inputAsset":{"contract":selected["contract"],"decimals":6},"maximumInput":"5100000","principal":"5000000",
        "sourceGasMaximum":"1000000000000000000","routingFeeMaximum":"100000","withdrawalFeeMaximum":"100000",
        "payoutMinimum":"1000000","quoteHash":quote_hash,"quoteExpiresAt":issued+900_000,"registrationClosesAt":f.start,
        "authorizationExpiresAt":issued+900_000,"reservationExpiresAt":issued+300_000});
    let consent_id = uuid(10100);
    let nonce = [19u8; 32];
    let nonce64 = STANDARD.encode(nonce);
    let terms_hash = hash(&terms);
    let message = [
        "Showup event financial consent v1".to_string(),
        "DISPOSABLE SANDBOX TOKENS ONLY. No real USDC or live funding route is authorized.".into(),
        "Website: https://localhost:3443".into(),
        "Authorize only the event and limits below. A separate wallet transaction is required to transfer funds.".into(),
        "A signature, quote or reservation creates no funded seat. Enrollment requires actual attributable escrow.".into(),
        "Principal and payout limits use USDC atomic units (1 USDC = 1000000).".into(),
        "Maximum input uses the selected input asset units. Source gas maximum uses native atomic units.".into(),
        "Routing and withdrawal fee maxima use USDC atomic units. The platform fee is zero.".into(),
        "Principal returns less disclosed, authorized delivery fees. Unresolved amounts remain recoverable.".into(),
        format!("Consent: {consent_id}"),format!("Nonce: {nonce64}"),format!("Issued: {}",iso(issued)),
        format!("Sign before: {}",iso(issued+300_000)),format!("Terms SHA-256: {terms_hash}"),terms.to_string(),
    ].join("\n");
    let consent = json!({"format":"showup.commitment.consent.v1","id":consent_id,"origin":"https://localhost:3443",
        "nonce":nonce64,"issuedAt":issued,"signingExpiresAt":issued+300_000,"terms":terms,"termsHash":terms_hash,"message":message});
    let source_proof = match network {
        "near" => {
            let payload = borsh::to_vec(&(
                2_u32.pow(31) + 413,
                message.as_str(),
                nonce,
                "localhost:3443",
                Some(format!(
                    "https://localhost:3443/account/commitments?consent={consent_id}"
                )),
            ))
            .unwrap();
            json!({"accountId":address,"publicKey":source_key.public_key().to_string(),"signature":STANDARD.encode(signature(&source_key,&Sha256::digest(payload)))})
        }
        "solana" => json!({"signature":STANDARD.encode(signature(&source_key,message.as_bytes()))}),
        _ => {
            let digest = Keccak256::digest(format!(
                "\x19Ethereum Signed Message:\n{}{message}",
                message.len()
            ));
            let mut bytes = signature(&source_key, &digest);
            if network == "base" {
                let parity = bytes.pop().unwrap();
                bytes[32] |= parity << 7; // EIP-2098 compact form.
            } else {
                bytes[64] += 27;
            }
            json!({"signature":format!("0x{}",hex(&bytes))})
        }
    };
    auth["wallet_tag"] = json!(hash(
        &json!({"format":"showup.funding.wallet.v1","deployment":f.escrow.id(),
        "environment":"sandbox","manifest":f.manifest,"event":f.event,"family":if ["base","ethereum"].contains(&network) {"evm"} else {network},"address":address})
    ));
    auth["nonce"] = json!(hash(
        &json!({"format":"showup.commitment.nonce.v1","id":consent_id,"nonce":nonce64})
    ));
    auth["expires_ms"] = json!(issued + 900_000);
    auth["reservation_ms"] = json!(issued + 300_000);
    auth["wallet_consent"] =
        json!(json!({"consent":consent,"proof":source_proof,"acceptedAt":issued}).to_string());
    (f, auth, quote, provider)
}
async fn reserve(
    f: &Fixture,
    auth: &Value,
    quote: &Value,
) -> near_workspaces::result::ExecutionFinalResult {
    let signer = if auth["source"]["network"] == "near" {
        &f.alice
    } else {
        &f.host
    };
    signer.call(f.escrow.id(),"reserve_routed").args_json(json!({"authorization":auth,"proof":proof(&f.credential,auth),"quote":quote.to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap()
}
fn reference() -> Value {
    json!({"kind":"routed_commitment","registration":id(100)})
}

#[tokio::test]
async fn routed_wallet_consent_requires_actual_receipt_and_returns_original_principal() {
    let mut vectors = vec![];
    for network in ["near", "base", "ethereum", "solana"] {
        let (f, auth, quote, provider) = fixture(network).await;
        let mut forged = auth.clone();
        let mut envelope: Value =
            serde_json::from_str(auth["wallet_consent"].as_str().unwrap()).unwrap();
        let original = envelope["proof"]["signature"].as_str().unwrap();
        envelope["proof"]["signature"] = json!(if network == "base" || network == "ethereum" {
            format!(
                "0x{}{}",
                if &original[2..4] == "00" { "01" } else { "00" },
                &original[4..]
            )
        } else {
            let mut bytes = STANDARD.decode(original).unwrap();
            bytes[0] ^= 1;
            STANDARD.encode(bytes)
        });
        forged["wallet_consent"] = json!(envelope.to_string());
        assert!(
            reserve(&f, &forged, &quote).await.into_result().is_err(),
            "Credential authority bypassed {network} source signature"
        );
        reserve(&f, &auth, &quote).await.into_result().unwrap();
        assert_eq!(
            f.view("get_registration", json!({"registration":id(100)}))
                .await["state"],
            "reserved"
        );
        assert_eq!(f.balance(f.escrow.id().as_str()).await, 0);
        assert_eq!(f.transfer(&f.bob, 5_000_000, reference()).await, "5000000");
        assert_eq!(
            f.view("get_registration", json!({"registration":id(100)}))
                .await["state"],
            "funded"
        );
        f.host
            .call(f.escrow.id(), "cancel_or_abort")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        f.host
            .call(f.escrow.id(), "withdraw")
            .args_json(json!({"id":format!("{}:principal",id(100))}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(f.balance(f.alice.id().as_str()).await, 105_000_000);
        assert_eq!(f.liability(100, "principal").await["paid"], "5000000");
        assert_eq!(f.view("accounting", json!({})).await["owed"], "0");
        vectors.push(json!({"network":network,"authorization":auth,"quote":quote,"quoteKey":provider.public_key().to_string(),
            "profile":{"environment":"sandbox","manifest":f.manifest,"token":f.token.id()},
            "registration":f.view("get_registration",json!({"registration":id(100)})).await,
            "binding":f.view("get_routed_funding",json!({"registration":id(100)})).await,
            "principal":f.liability(100,"principal").await,"accounting":f.view("accounting",json!({})).await}));
    }
    std::fs::write(
        "/cache/routed-funding-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn routed_receipts_preserve_short_excess_duplicate_late_and_unqualified_return_debt() {
    let (f, auth, quote, _) = fixture("solana").await;
    reserve(&f, &auth, &quote).await.into_result().unwrap();
    assert_eq!(
        f.transfer(&f.alice, 5_000_000, reference()).await,
        "0",
        "Wrong provider accepted"
    );
    assert_eq!(
        f.transfer(
            &f.bob,
            5_000_000,
            json!({"kind":"routed_commitment","registration":id(999)})
        )
        .await,
        "0"
    );
    assert_eq!(f.transfer(&f.bob, 4_000_000, reference()).await, "4000000");
    assert_eq!(
        f.view("get_registration", json!({"registration":id(100)}))
            .await["state"],
        "reserved"
    );
    assert_eq!(f.liability(100, "return").await["total"], "4000000");
    assert_eq!(f.transfer(&f.bob, 5_100_000, reference()).await, "5100000");
    assert_eq!(f.transfer(&f.bob, 5_000_000, reference()).await, "5000000");
    assert_eq!(f.liability(100, "return").await["total"], "9100000");
    assert_eq!(
        f.liability(100, "return").await["destination"],
        auth["refund"]
    );
    assert!(
        f.host
            .call(f.escrow.id(), "withdraw")
            .args_json(json!({"id":format!("{}:return",id(100))}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .is_err(),
        "Unqualified external return claimed paid"
    );
    assert_eq!(f.liability(100, "return").await["paid"], "0");
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 14_100_000);
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["funded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (late, auth, quote, _) = fixture("base").await;
    reserve(&late, &auth, &quote).await.into_result().unwrap();
    late.advance(auth["expires_ms"].as_u64().unwrap() + 1).await;
    assert_eq!(
        late.transfer(&late.bob, 5_000_000, reference()).await,
        "5000000"
    );
    assert_eq!(
        late.view("get_event", json!({"event":late.event})).await["funded"],
        json!([])
    );
    assert_eq!(late.liability(100, "return").await["total"], "5000000");
    assert_eq!(
        late.liability(100, "return").await["destination"],
        auth["refund"]
    );
}

#[tokio::test]
async fn routed_authorization_cannot_replace_wallet_quote_destinations_or_source_control() {
    let (f, auth, quote, provider) = fixture("near").await;
    assert!(f.host.call(f.escrow.id(),"reserve_routed").args_json(json!({"authorization":auth,"proof":proof(&f.credential,&auth),"quote":quote.to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap().into_result().is_err());
    for field in ["refund", "payout", "source"] {
        let mut changed = auth.clone();
        changed[field] = f.destination(f.bob.id().as_str());
        assert!(
            reserve(&f, &changed, &quote).await.into_result().is_err(),
            "Credential authority redirected {field}"
        );
    }
    let mut changed = quote.clone();
    changed["quote"]["depositAddress"] = json!("substitute.near");
    sign_quote(&mut changed, &provider);
    assert!(
        reserve(&f, &auth, &changed).await.into_result().is_err(),
        "New valid provider quote replaced original wallet quote binding"
    );
    changed = quote.clone();
    changed["quoteRequest"]["deadline"] = json!(iso(auth["expires_ms"].as_u64().unwrap() + 1));
    assert_eq!(
        quote_fields::quote_fields(&changed).fields,
        quote_fields::quote_fields(&quote).fields
    );
    assert!(
        reserve(&f, &auth, &changed).await.into_result().is_err(),
        "Unsigned overwritten request deadline escaped the wallet deadline"
    );
    reserve(&f, &auth, &quote).await.into_result().unwrap();
    assert_eq!(
        f.fund(&f.alice, &auth, 5_000_000).await,
        "0",
        "Direct receipt bypassed routed reference"
    );
    reserve(&f, &auth, &quote).await.into_result().unwrap();
    assert_eq!(f.transfer(&f.bob, 5_000_000, reference()).await, "5000000");
    assert_eq!(
        f.view("get_registration", json!({"registration":id(100)}))
            .await["state"],
        "funded"
    );
}

async fn return_ready(network: &str) -> (Fixture, Value, SecretKey) {
    let (f, auth, quote, provider) = fixture_with_returns(network, true).await;
    reserve(&f, &auth, &quote).await.into_result().unwrap();
    assert_eq!(f.transfer(&f.bob, 5_000_000, reference()).await, "5000000");
    f.release(&auth).await;
    (f, auth, provider)
}
async fn return_quote(
    f: &Fixture,
    auth: &Value,
    provider: &SecretKey,
    deposit: &str,
    gross: u128,
) -> Value {
    let now = f.timestamp().await;
    let policy =
        f.view("get_event", json!({"event":f.event})).await["terms"]["routing_policy"].clone();
    let asset = policy["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["network"] == auth["payout"]["network"])
        .unwrap();
    let mut quote = json!({"timestamp":iso(now),"quoteRequest":{"dry":false,"swapType":"EXACT_INPUT","slippageTolerance":100,
        "originAsset":format!("nep141:{}",f.token.id()),"depositType":"ORIGIN_CHAIN","destinationAsset":asset["route_asset"],
        "amount":gross.to_string(),"refundTo":f.escrow.id(),"refundType":"ORIGIN_CHAIN","recipient":auth["payout"]["address"],
        "recipientType":"DESTINATION_CHAIN","deadline":iso(now+300_000),"quoteWaitingTimeMs":3000,
        "appFees":[{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":1}]},
        "quote":{"amountIn":gross.to_string(),"minAmountIn":gross.to_string(),"amountOut":(gross-50_000).to_string(),
        "minAmountOut":(gross-80_000).to_string(),"amountInFormatted":"5","amountInUsd":"5","amountOutFormatted":"4.95","amountOutUsd":"4.95",
        "depositAddress":deposit,"deadline":iso(now+180_000),"refundFee":"20000","withdrawFee":"10000"}});
    sign_quote(&mut quote, provider);
    quote
}
async fn dispatch(f: &Fixture, quote: &Value) -> near_workspaces::result::ExecutionFinalResult {
    dispatch_kind(f, quote, "principal").await
}
async fn dispatch_kind(
    f: &Fixture,
    quote: &Value,
    kind: &str,
) -> near_workspaces::result::ExecutionFinalResult {
    f.escrow
        .call("route_return")
        .args_json(json!({"registration":id(100),"kind":kind,"quote":quote.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap()
}

#[tokio::test]
async fn routed_return_cannot_discharge_another_liability_with_the_same_destination_transfer() {
    let (f, auth, provider) = return_ready("base").await;
    let quote = return_quote(&f, &auth, &provider, f.bob.id().as_str(), 5_000_000).await;
    dispatch(&f, &quote).await.into_result().unwrap();
    let first = observation(&f, "delivered", 4_950_000).await;
    observe(&f, &first).await.into_result().unwrap();
    // Another real token arrival creates separate debt to the original refund.
    assert_eq!(f.transfer(&f.bob, 5_000_000, reference()).await, "5000000");
    let mut next = return_quote(&f, &auth, &provider, f.host.id().as_str(), 5_000_000).await;
    next["quote"]["minAmountOut"] = json!("4950000");
    sign_quote(&mut next, &provider);
    dispatch_kind(&f, &next, "return")
        .await
        .into_result()
        .unwrap();
    let repeated = observation(&f, "delivered", 4_950_000).await;
    assert_eq!(repeated["transaction"], first["transaction"]);
    observe(&f, &repeated).await.into_result().unwrap();
    assert_eq!(returns(&f).await["paused"], true);
    assert_eq!(f.liability(100, "return").await["paid"], "0");
    assert_eq!(f.view("accounting", json!({})).await["owed"], "5000000");
    assert_eq!(returns(&f).await["fees_used"], "50000");
}
async fn returns(f: &Fixture) -> Value {
    f.view("get_routed_returns", json!({"registration":id(100)}))
        .await
}
fn return_image(attempt: &Value) -> String {
    hash(
        &json!({"format":"showup.routed-return.image.v1","number":attempt["number"],"liability":attempt["liability"],
        "quote_hash":attempt["quote_hash"],"deposit":attempt["deposit"],"destination":attempt["destination"],"gross":attempt["gross"],
        "quoted_net":attempt["quoted_net"],"minimum_net":attempt["minimum_net"],"refund_fee":attempt["refund_fee"],"deadline_ms":attempt["deadline_ms"]}),
    )
}
async fn observation(f: &Fixture, kind: &str, amount: u128) -> Value {
    let ledger = returns(f).await;
    let attempt = ledger["attempts"].as_array().unwrap().last().unwrap();
    let network = if kind == "refunded" {
        "near"
    } else {
        attempt["destination"]["network"].as_str().unwrap()
    };
    let now = f.timestamp().await;
    let block = if network == "base" || network == "ethereum" {
        format!("0x{}", id(100))
    } else {
        bs58::encode([10u8; 32]).into_string()
    };
    let transaction = match network {
        "base" | "ethereum" => format!("0x{}", id(101)),
        "solana" => bs58::encode([11u8; 64]).into_string(),
        _ => bs58::encode([11u8; 32]).into_string(),
    };
    json!({"format":"showup.routed-return.observation.v1","domain":f.domain,"deployment":f.escrow.id(),"manifest":f.manifest,
        "event":f.event,"rules_hash":f.rules_hash,"registration":id(100),"liability":attempt["liability"],"number":attempt["number"],
        "image_hash":return_image(attempt),"profile_hash":id(9600),"sources":["fixture-one","fixture-two"],"kind":kind,
        "network":network,"chain_id":match network {"near"=>"sandbox","base"=>"84532","ethereum"=>"11155111",_=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"},
        "asset":if kind=="refunded" {json!(f.token.id())} else {attempt["destination"]["asset"].clone()},
        "recipient":if kind=="refunded" {json!(f.escrow.id())} else {attempt["destination"]["address"].clone()},
        "amount":amount.to_string(),"transaction":transaction,"event_index":0,"transaction_block_height":"100","transaction_block_hash":block,
        "transaction_ms":now-1000,"block_height":"100","block_hash":block,"block_ms":now-500,"observed_ms":now,"expires_ms":now+60_000,"finalized":true})
}
async fn observe(f: &Fixture, receipt: &Value) -> near_workspaces::result::ExecutionFinalResult {
    f.host
        .call(f.escrow.id(), "observe_routed_return")
        .args_json(json!({"receipt":receipt,"proof":proof(&f.observer,receipt)}))
        .max_gas()
        .transact()
        .await
        .unwrap()
}
async fn return_export(
    f: &Fixture,
    stage: &str,
    auth: &Value,
    quote: &Value,
    provider: &SecretKey,
) -> Value {
    json!({"stage":stage,"authorization":auth,"quote":quote,"quoteKey":provider.public_key().to_string(),
        "observerKey":STANDARD.encode(f.observer.verifying_key().to_bytes()),"ledger":returns(f).await,
        "profile":{"environment":"sandbox","manifest":f.manifest,"token":f.token.id()},
        "principal":f.liability(100,"principal").await,"accounting":f.view("accounting",json!({})).await,
        "tokenBalance":f.balance(f.escrow.id().as_str()).await.to_string()})
}

#[tokio::test]
async fn routed_return_dispatch_binds_debt_and_keeps_destination_evidence_separate_on_each_external_network()
 {
    let mut vectors = vec![];
    for network in ["base", "ethereum", "solana"] {
        let (f, auth, provider) = return_ready(network).await;
        let quote = return_quote(&f, &auth, &provider, f.bob.id().as_str(), 5_000_000).await;
        for field in ["recipient", "refundTo", "destinationAsset"] {
            let mut changed = quote.clone();
            changed["quoteRequest"][field] = json!("substitute.near");
            sign_quote(&mut changed, &provider);
            assert!(
                dispatch(&f, &changed).await.into_result().is_err(),
                "Return changed {field}"
            );
        }
        let mut expensive = quote.clone();
        expensive["quote"]["minAmountOut"] = json!("4800000");
        sign_quote(&mut expensive, &provider);
        assert!(dispatch(&f, &expensive).await.into_result().is_err());
        let mut platform_fee = quote.clone();
        platform_fee["quoteRequest"]["appFees"] =
            json!([{"recipient":"substitute.near","fee":100}]);
        assert!(dispatch(&f, &platform_fee).await.into_result().is_err());
        dispatch(&f, &quote).await.into_result().unwrap();
        assert_eq!(f.balance(f.escrow.id().as_str()).await, 0);
        assert_eq!(f.liability(100, "principal").await["paid"], "0");
        assert_eq!(returns(&f).await["attempts"][0]["state"], "submitted");
        assert_eq!(
            f.view("accounting", json!({})).await["routed_in_flight"],
            "5000000"
        );
        assert!(
            dispatch(&f, &quote).await.into_result().is_err(),
            "Pending principal spent twice"
        );
        vectors.push(return_export(&f, "submitted", &auth, &quote, &provider).await);
        let receipt = observation(&f, "delivered", 4_950_000).await;
        let mut changed = receipt.clone();
        changed["recipient"] = json!("substitute.near");
        assert!(observe(&f, &changed).await.into_result().is_err());
        observe(&f, &receipt).await.into_result().unwrap();
        observe(&f, &receipt).await.into_result().unwrap();
        assert_eq!(f.liability(100, "principal").await["paid"], "5000000");
        assert_eq!(returns(&f).await["fees_used"], "50000");
        assert_eq!(f.view("accounting", json!({})).await["owed"], "0");
        assert!(dispatch(&f, &quote).await.into_result().is_err());
        let mut exported = return_export(&f, "delivered", &auth, &quote, &provider).await;
        exported["proof"] = json!(proof(&f.observer, &receipt));
        vectors.push(exported);
    }
    std::fs::write(
        "/cache/routed-return-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn routed_return_failure_and_refund_recovery_do_not_replenish_fees_or_spend_unreturned_principal()
 {
    let (f, auth, provider) = return_ready("base").await;
    let absent = f.worker.dev_create_account().await.unwrap();
    let failed = return_quote(&f, &auth, &provider, absent.id().as_str(), 5_000_000).await;
    dispatch(&f, &failed).await.into_result().unwrap();
    let mut vectors = vec![return_export(&f, "failed", &auth, &failed, &provider).await];
    assert_eq!(returns(&f).await["attempts"][0]["state"], "failed");
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 5_000_000);
    assert_eq!(f.liability(100, "principal").await["pending"], Value::Null);
    let quote = return_quote(&f, &auth, &provider, f.bob.id().as_str(), 5_000_000).await;
    dispatch(&f, &quote).await.into_result().unwrap();
    vectors.push(return_export(&f, "submitted", &auth, &quote, &provider).await);
    let refunded = observation(&f, "refunded", 4_980_000).await;
    observe(&f, &refunded).await.into_result().unwrap();
    vectors.push(return_export(&f, "refund_check_needed", &auth, &quote, &provider).await);
    assert_eq!(
        returns(&f).await["attempts"][1]["state"],
        "refund_check_needed"
    );
    assert_eq!(returns(&f).await["fees_used"], "0");
    assert_eq!(f.liability(100, "principal").await["paid"], "0");
    assert!(dispatch(&f, &quote).await.into_result().is_err());
    f.bob.call(f.token.id(),"ft_transfer").args_json(json!({"receiver_id":f.escrow.id(),"amount":"4980000","memo":"simulated provider refund"}))
        .deposit(NearToken::from_yoctonear(1)).transact().await.unwrap().into_result().unwrap();
    f.escrow
        .call("recheck_routed_refund")
        .args_json(json!({"registration":id(100),"number":2}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(returns(&f).await["attempts"][1]["state"], "refunded");
    assert_eq!(returns(&f).await["fees_used"], "20000");
    assert_eq!(f.liability(100, "principal").await["paid"], "20000");
    assert_eq!(f.view("accounting", json!({})).await["owed"], "4980000");
    vectors.push(return_export(&f, "refunded", &auth, &quote, &provider).await);
    let third = return_quote(&f, &auth, &provider, f.host.id().as_str(), 4_980_000).await;
    let mut costly = third.clone();
    costly["quote"]["minAmountOut"] = json!("4899999");
    sign_quote(&mut costly, &provider);
    assert!(
        dispatch(&f, &costly).await.into_result().is_err(),
        "A refund replenished its spent fee budget"
    );
    dispatch(&f, &third).await.into_result().unwrap();
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 0);
    let mut delivered = observation(&f, "delivered", 4_930_000).await;
    observe(&f, &delivered).await.into_result().unwrap();
    let mut final_vector = return_export(&f, "delivered", &auth, &third, &provider).await;
    final_vector["proof"] = json!(proof(&f.observer, &delivered));
    vectors.push(final_vector);
    assert_eq!(returns(&f).await["fees_used"], "70000");
    assert_eq!(f.liability(100, "principal").await["paid"], "5000000");
    assert_eq!(f.view("accounting", json!({})).await["owed"], "0");
    delivered["amount"] = json!("4929999");
    observe(&f, &delivered).await.into_result().unwrap();
    assert_eq!(
        returns(&f).await["paused"],
        true,
        "Conflicting signed delivery did not pause further routing"
    );
    assert_eq!(returns(&f).await["fees_used"], "70000");
    std::fs::write(
        "/cache/routed-return-recovery-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}
