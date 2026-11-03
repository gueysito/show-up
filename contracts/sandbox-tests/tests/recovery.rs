mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn hash(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            STANDARD
                .decode(value["unsigned"].as_str().unwrap())
                .unwrap()
        )
    )
}
fn envelope_hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
fn sol_key(n: u8) -> String {
    bs58::encode([n; 32]).into_string()
}
fn evm(nonce: u64, max: &str, tip: &str) -> Value {
    json!({"nonce":nonce,"gas_limit":100000,"max_fee_per_gas":max,"max_priority_fee_per_gas":tip})
}
fn sol(n: u8, expiry: u64) -> Value {
    json!({"blockhash":sol_key(n),"compute_units":100000,"estimated_fee":"5000","last_valid_block_height":expiry.to_string()})
}
async fn setup(network: &str, cap: &str) -> (Fixture, Value, Value, Value) {
    let addr = |n: u8| {
        if network == "solana" {
            sol_key(n)
        } else {
            format!("0x{}", format!("{n:02x}").repeat(20))
        }
    };
    let policy = json!({"network":network,"collection":addr(1),"asset":if network=="solana" {addr(2)}else{format!("0x{}",id(1))},
        "source":addr(3),"beneficiary":addr(4),"contributor":addr(6),"fee_cap":cap});
    let f = Fixture::with_custody(1, "online", 0, Some(policy)).await;
    f.host
        .call(f.escrow.id(), "cancel_or_abort")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let intent: Value = f
        .escrow
        .call("lock_custody_intent")
        .args_json(json!({"event":f.event,"operation":"return"}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    let env = if network == "solana" {
        sol(5, 150)
    } else {
        evm(
            if network == "ethereum" { 256 } else { 0 },
            "1000000000",
            "500000000",
        )
    };
    let image: Value = f
        .escrow
        .call(if network == "solana" {
            "prepare_solana_custody"
        } else {
            "prepare_evm_custody"
        })
        .args_json(json!({"event":f.event,"envelope":env}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    (f, intent, image, env)
}
async fn witness(
    f: &Fixture,
    intent: &Value,
    previous: &Value,
    envelope: &Value,
    reason: &str,
    number: u64,
) -> Value {
    let network = intent["network"].as_str().unwrap();
    let current = f.timestamp().await;
    json!({"format":"showup.custody.recovery.v1","domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
        "manifest":intent["manifest"],"event":f.event,"rules_hash":f.rules_hash,"network":network,
        "chain_id":match network {"base"=>"84532","ethereum"=>"11155111",_=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"},
        "profile_hash":id(9400),"sources":["fixture-one","fixture-two"],"intent_hash":previous["intent_hash"],
        "previous_image_hash":hash(previous),"new_envelope_hash":envelope_hash(envelope),"reason":reason,"owner":intent["source"],
        "account_nonce":if network=="solana" {Value::Null}else{json!(envelope["nonce"].as_u64().unwrap().to_string())},
        "failed_image_hash":null,"transaction":if network=="solana" {json!(bs58::encode([7u8;64]).into_string())} else {Value::Null},"transaction_failed":false,"signature_status_absent":network=="solana",
        "blockhash_valid":if network=="solana" {json!(false)}else{Value::Null},"new_blockhash_valid":if network=="solana" {json!(true)}else{Value::Null},
        "transaction_block_height":null,"transaction_block_hash":null,"reported_fee":"0","block_height":"1000",
        "block_hash":if network=="solana" {sol_key(10)}else{format!("0x{}",id(1000))},"block_ms":current-1000,
        "finalized_block_height":if network=="solana" {json!("151")}else{Value::Null},"observed_ms":current,"expires_ms":current+60000,"nonce":id(number)})
}
fn failed(receipt: &mut Value, image: &Value, network: &str) {
    receipt["failed_image_hash"] = json!(hash(image));
    receipt["transaction_failed"] = json!(true);
    receipt["signature_status_absent"] = json!(false);
    receipt["transaction"] = json!(if network == "solana" {
        bs58::encode([7u8; 64]).into_string()
    } else {
        format!("0x{}", id(700))
    });
    receipt["transaction_block_height"] = json!("900");
    receipt["transaction_block_hash"] = json!(if network == "solana" {
        sol_key(11)
    } else {
        format!("0x{}", id(900))
    });
}
async fn recover(
    f: &Fixture,
    receipt: &Value,
    envelope: &Value,
) -> near_workspaces::result::ExecutionFinalResult {
    f.bob
        .call(
            f.escrow.id(),
            if receipt["network"] == "solana" {
                "recover_solana_custody"
            } else {
                "recover_evm_custody"
            },
        )
        .args_json(
            json!({"receipt":receipt,"proof":proof(&f.observer,receipt),"envelope":envelope}),
        )
        .transact()
        .await
        .unwrap()
}

#[tokio::test]
async fn evm_recovery_keeps_nonce_lineage_and_cannot_replenish_reserved_fees_or_change_intent() {
    let mut vectors = vec![];
    for network in ["base", "ethereum"] {
        let (f, intent, original, initial) = setup(network, "300000000000000").await;
        assert_eq!(original["reserved_fee"], "100000000000000");
        let nonce = initial["nonce"].as_u64().unwrap();
        let bump = evm(nonce, "1500000000", "750000000");
        let receipt = witness(&f, &intent, &original, &bump, "same_nonce", 21000).await;
        for (field, value) in [
            ("format", json!("wrong")),
            ("domain", json!("wrong")),
            ("deployment", json!(f.token.id())),
            ("manifest", json!("wrong")),
            ("event", json!(id(800))),
            ("rules_hash", json!(id(801))),
            ("network", json!("solana")),
            ("chain_id", json!("1")),
            ("profile_hash", json!(id(802))),
            ("sources", json!(["fixture-one", "fixture-one"])),
            ("intent_hash", json!(id(803))),
            ("previous_image_hash", json!(id(804))),
            ("new_envelope_hash", json!(id(805))),
            ("reason", json!("arbitrary")),
            ("owner", intent["recipient"].clone()),
            ("account_nonce", json!((nonce + 1).to_string())),
            ("transaction_failed", json!(true)),
            ("signature_status_absent", json!(true)),
            ("blockhash_valid", json!(false)),
            ("new_blockhash_valid", json!(true)),
            ("reported_fee", json!("1")),
            ("block_height", json!("0")),
            ("block_hash", json!("wrong")),
            ("block_ms", json!(f.start)),
            ("observed_ms", json!(f.start)),
            ("expires_ms", json!(1)),
            ("nonce", json!("wrong")),
        ] {
            let mut changed = receipt.clone();
            changed[field] = value;
            assert!(
                recover(&f, &changed, &bump).await.is_failure(),
                "Accepted recovery field {field}"
            );
        }
        assert!(
            f.bob
                .call(f.escrow.id(), "recover_evm_custody")
                .args_json(
                    json!({"receipt":receipt,"proof":proof(&f.credential,&receipt),"envelope":bump})
                )
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        let replaced: Value = recover(&f, &receipt, &bump)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(replaced["generation"], 2);
        assert_eq!(replaced["reserved_fee"], "150000000000000");
        assert_eq!(replaced["intent_hash"], original["intent_hash"]);
        assert_eq!(replaced["path"], original["path"]);
        let repeated: Value = recover(&f, &receipt, &bump)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(repeated, replaced);
        let mut changed = receipt.clone();
        changed["block_height"] = json!("1001");
        assert!(
            recover(&f, &changed, &bump).await.is_failure(),
            "Nonce replay cannot silently change its signed payload"
        );
        let next = evm(nonce + 1, "1000000000", "500000000");
        let mut consumed = witness(&f, &intent, &replaced, &next, "failed_nonce", 21001).await;
        failed(&mut consumed, &original, network); // Any known variant of the consumed nonce may have landed.
        let mut missing = consumed.clone();
        missing["transaction_failed"] = json!(false);
        assert!(recover(&f, &missing, &next).await.is_failure());
        let excessive = evm(nonce + 1, "2000000000", "1000000000");
        let mut high = consumed.clone();
        high["new_envelope_hash"] = json!(envelope_hash(&excessive));
        assert!(
            recover(&f, &high, &excessive).await.is_failure(),
            "Reported zero fee cannot release the old reservation"
        );
        let advanced: Value = recover(&f, &consumed, &next)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(advanced["generation"], 3);
        assert_eq!(advanced["reserved_fee"], "250000000000000");
        let fourth = evm(nonce + 2, "100000000", "50000000");
        let mut limit = witness(&f, &intent, &advanced, &fourth, "failed_nonce", 21002).await;
        failed(&mut limit, &advanced, network);
        assert!(
            recover(&f, &limit, &fourth).await.is_failure(),
            "Bounded signing-image count cannot be reset"
        );
        assert_eq!(
            f.view("get_custody_history", json!({"event":f.event}))
                .await
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            f.view("get_custody_intent", json!({"event":f.event})).await,
            intent
        );
        f.advance(receipt["expires_ms"].as_u64().unwrap() + 1).await;
        let expired_replay: Value = recover(&f, &receipt, &bump)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(expired_replay, replaced);
        assert_eq!(
            f.view("get_custody_image", json!({"event":f.event})).await,
            advanced
        );
        vectors.push(json!({"intent":intent,"policy":f.view("get_event",json!({"event":f.event})).await["terms"]["observer_policy"],
            "receipt":consumed,"proof":proof(&f.observer,&consumed),"envelope":next,"image":advanced,
            "history":f.view("get_custody_history",json!({"event":f.event})).await}));
    }
    std::fs::write(
        "/cache/custody-recovery-public.json",
        json!(vectors).to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn solana_expiry_requires_block_height_invalid_hash_and_history_reconciliation_without_freeing_fees()
 {
    let (f, intent, original, _) = setup("solana", "10000").await;
    let next = sol(6, 250);
    let receipt = witness(&f, &intent, &original, &next, "solana_expired", 22000).await;
    for (field, value) in [
        ("finalized_block_height", json!("150")),
        ("blockhash_valid", json!(true)),
        ("new_blockhash_valid", json!(false)),
        ("signature_status_absent", json!(false)),
        ("account_nonce", json!("1")),
        ("transaction_failed", json!(true)),
        ("reported_fee", json!("1")),
        ("transaction", Value::Null),
    ] {
        let mut changed = receipt.clone();
        changed[field] = value;
        assert!(
            recover(&f, &changed, &next).await.is_failure(),
            "Accepted unsafe Solana recovery {field}"
        );
    }
    let mut reuse = sol(5, 250);
    let mut same = receipt.clone();
    same["new_envelope_hash"] = json!(envelope_hash(&reuse));
    assert!(recover(&f, &same, &reuse).await.is_failure());
    reuse = sol(6, 302);
    same["new_envelope_hash"] = json!(envelope_hash(&reuse));
    assert!(recover(&f, &same, &reuse).await.is_failure());
    let rebuilt: Value = recover(&f, &receipt, &next)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(rebuilt["generation"], 2);
    assert_eq!(rebuilt["reserved_fee"], "10000");
    let third = sol(7, 350);
    let mut exhausted = witness(&f, &intent, &rebuilt, &third, "solana_expired", 22001).await;
    exhausted["finalized_block_height"] = json!("251");
    assert!(
        recover(&f, &exhausted, &third).await.is_failure(),
        "An expiry report cannot erase the first fee reservation"
    );
    assert_eq!(
        f.view("get_custody_history", json!({"event":f.event}))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        f.view("get_custody_intent", json!({"event":f.event})).await,
        intent
    );
    std::fs::write("/cache/custody-recovery-solana-expiry-public.json",json!([{
        "intent":intent,"policy":f.view("get_event",json!({"event":f.event})).await["terms"]["observer_policy"],
        "receipt":receipt,"proof":proof(&f.observer,&receipt),"envelope":next,"image":rebuilt,
        "history":f.view("get_custody_history",json!({"event":f.event})).await}]).to_string()).unwrap();
}

#[tokio::test]
async fn confirmed_solana_failure_only_resolves_its_current_image_and_preserves_the_attempt_limit()
{
    let (f, intent, original, _) = setup("solana", "20000").await;
    let next = sol(6, 200);
    let mut receipt = witness(&f, &intent, &original, &next, "solana_failed", 23000).await;
    receipt["finalized_block_height"] = json!("100");
    receipt["blockhash_valid"] = json!(true);
    failed(&mut receipt, &original, "solana");
    let rebuilt: Value = recover(&f, &receipt, &next)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    let third = sol(7, 210);
    let mut another = witness(&f, &intent, &rebuilt, &third, "solana_failed", 23001).await;
    another["finalized_block_height"] = json!("110");
    another["blockhash_valid"] = json!(true);
    failed(&mut another, &original, "solana");
    assert!(
        recover(&f, &another, &third).await.is_failure(),
        "An older failed signature cannot resolve a newer pending image"
    );
    failed(&mut another, &rebuilt, "solana");
    let final_image: Value = recover(&f, &another, &third)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(final_image["reserved_fee"], "15000");
    let fourth = sol(8, 220);
    let mut final_receipt =
        witness(&f, &intent, &final_image, &fourth, "solana_failed", 23002).await;
    final_receipt["finalized_block_height"] = json!("120");
    final_receipt["blockhash_valid"] = json!(true);
    failed(&mut final_receipt, &final_image, "solana");
    assert!(recover(&f, &final_receipt, &fourth).await.is_failure());
    assert_eq!(
        f.view("get_custody_history", json!({"event":f.event}))
            .await
            .as_array()
            .unwrap()
            .len(),
        3
    );
    std::fs::write("/cache/custody-recovery-solana-failure-public.json",json!([{
        "intent":intent,"policy":f.view("get_event",json!({"event":f.event})).await["terms"]["observer_policy"],
        "receipt":another,"proof":proof(&f.observer,&another),"envelope":third,"image":final_image,
        "history":f.view("get_custody_history",json!({"event":f.event})).await}]).to_string()).unwrap();
}

async fn observation_case(late: bool) {
    let (f, intent, original, initial) = setup("base", "300000000000000").await;
    let mut latest = original.clone();
    if late {
        let bump = evm(
            initial["nonce"].as_u64().unwrap(),
            "1500000000",
            "750000000",
        );
        let permit = witness(&f, &intent, &original, &bump, "same_nonce", 24000).await;
        latest = recover(&f, &permit, &bump)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
    }
    let mut receipt = f.holding_observation().await;
    receipt["block_height"] = json!("2000");
    receipt["block_hash"] = json!(format!("0x{}", id(2000)));
    receipt["operation"] = json!("return");
    receipt["owner"] = intent["recipient"].clone();
    receipt["intent_hash"] = original["intent_hash"].clone();
    receipt["image_hash"] = json!(hash(&original));
    receipt["transaction"] = json!(format!("0x{}", id(24001)));
    receipt["fee"] = json!(if late { "5000" } else { "300000000000001" });
    receipt["transaction_block_height"] = json!("50");
    receipt["transaction_block_hash"] = json!(format!("0x{}", id(50)));
    receipt["transaction_ms"] = json!(receipt["block_ms"].as_u64().unwrap() - 86_400_000);
    let state: Value = f
        .submit_observation(&receipt)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(state["delivered"], true);
    assert_eq!(state["paused"], !late);
    assert_eq!(state["fee_review_required"], !late);
    assert_eq!(
        f.view("get_custody_image", json!({"event":f.event})).await,
        latest
    );
    assert_eq!(
        f.view("get_custody_intent", json!({"event":f.event})).await,
        intent
    );
    assert_eq!(f.view("accounting", json!({})).await["delivered"], "0");
}

#[tokio::test]
async fn custody_observation_accepts_an_older_signing_image_that_actually_delivered() {
    observation_case(true).await;
}

#[tokio::test]
async fn custody_observation_records_delivery_and_pauses_when_actual_fees_exceed_the_cap() {
    observation_case(false).await;
}
