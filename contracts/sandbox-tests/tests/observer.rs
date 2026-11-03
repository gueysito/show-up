mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn policy(network: &str) -> Value {
    let address = |byte: u8| {
        if network == "solana" {
            bs58::encode([byte; 32]).into_string()
        } else {
            format!("0x{}", format!("{byte:02x}").repeat(20))
        }
    };
    json!({"network":network,"collection":address(1),"asset":if network == "solana" {address(2)} else {format!("0x{}",id(1))},
        "source":address(3),"beneficiary":address(4),"contributor":address(6),"fee_cap":"300000000000000"})
}

#[tokio::test]
async fn signed_observations_gate_publication_and_cannot_redirect_an_irreversible_intent() {
    let mut vectors = vec![];
    for network in ["base", "ethereum", "solana"] {
        let f = Fixture::with_unobserved_custody(policy(network)).await;
        let publish = || {
            f.host
                .call(f.escrow.id(), "publish")
                .args_json(json!({"event":f.event}))
        };
        assert!(publish().transact().await.unwrap().is_failure());
        let receipt = f.holding_observation().await;
        for (field, value) in [
            ("format", json!("wrong")),
            ("domain", json!("wrong")),
            ("deployment", json!(f.token.id())),
            ("manifest", json!("wrong")),
            ("event", json!(id(500))),
            ("rules_hash", json!(id(501))),
            ("network", json!("near")),
            ("chain_id", json!("1")),
            ("profile_hash", json!(id(502))),
            ("sources", json!(["fixture-one", "fixture-one"])),
            ("collection", json!("wrong")),
            ("asset", json!("wrong")),
            ("custody", json!("wrong")),
            ("operation", json!("arbitrary")),
            ("intent_hash", json!(id(503))),
            ("image_hash", json!(id(504))),
            ("transaction", json!("wrong")),
            ("block_height", json!("0")),
            ("block_hash", json!("wrong")),
            ("block_ms", json!(f.start)),
            ("observed_ms", json!(f.start)),
            ("expires_ms", json!(1)),
            ("finalized", json!(false)),
            ("fee", json!("1")),
        ] {
            let mut changed = receipt.clone();
            changed[field] = value;
            assert!(
                f.submit_observation(&changed).await.is_failure(),
                "Accepted changed observation {field}"
            );
        }
        assert!(
            f.bob
                .call(f.escrow.id(), "observe_asset")
                .args_json(json!({"receipt":receipt,
            "proof":proof(&f.credential,&receipt)}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        assert!(
            f.view("get_asset_observation", json!({"event":f.event}))
                .await
                .is_null()
        );
        let state: Value = f
            .submit_observation(&receipt)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(state["paused"], false);
        assert_eq!(state["delivered"], false);
        let repeated: Value = f
            .submit_observation(&receipt)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(state, repeated);
        publish().transact().await.unwrap().into_result().unwrap();
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
        let (method, envelope) = if network == "solana" {
            (
                "prepare_solana_custody",
                json!({"blockhash":bs58::encode([5u8;32]).into_string(),"compute_units":100000,"estimated_fee":"5000","last_valid_block_height":"150"}),
            )
        } else {
            (
                "prepare_evm_custody",
                json!({"nonce":0,"gas_limit":100000,"max_fee_per_gas":"2000000000","max_priority_fee_per_gas":"1000000000"}),
            )
        };
        let image: Value = f
            .escrow
            .call(method)
            .args_json(json!({"event":f.event,"envelope":envelope}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        let mut delivered = f.holding_observation().await;
        delivered["block_height"] = json!("101");
        delivered["operation"] = json!("return");
        delivered["owner"] = intent["recipient"].clone();
        delivered["intent_hash"] = image["intent_hash"].clone();
        delivered["image_hash"] = json!(format!(
            "{:x}",
            Sha256::digest(
                STANDARD
                    .decode(image["unsigned"].as_str().unwrap())
                    .unwrap()
            )
        ));
        delivered["transaction"] = json!(if network == "solana" {
            bs58::encode([7u8; 64]).into_string()
        } else {
            format!("0x{}", id(700))
        });
        delivered["fee"] = json!("5000");
        delivered["transaction_block_height"] = json!("100");
        delivered["transaction_block_hash"] = receipt["block_hash"].clone();
        delivered["transaction_ms"] = receipt["block_ms"].clone();
        for (field, value) in [
            ("owner", policy(network)["beneficiary"].clone()),
            ("operation", json!("delivery")),
            ("intent_hash", json!(id(800))),
            ("image_hash", json!(id(801))),
            ("transaction", json!("wrong")),
            ("transaction_block_height", json!("102")),
        ] {
            let mut changed = delivered.clone();
            changed[field] = value;
            assert!(
                f.submit_observation(&changed).await.is_failure(),
                "Observer replaced intent field {field}"
            );
        }
        let completed: Value = f
            .submit_observation(&delivered)
            .await
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(completed["delivered"], true);
        let terms = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
        let context = json!({"domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
            "event":f.event,"rules_hash":f.rules_hash,"custody":terms["custody_proof_policy"],
            "policy":terms["observer_policy"],"intent":intent,"image":image});
        vectors.push(
            json!({"context":context,"holding":receipt,"holding_proof":proof(&f.observer,&receipt),
            "delivered":delivered,"delivered_proof":proof(&f.observer,&delivered)}),
        );
        assert!(
            f.escrow
                .call("lock_custody_intent")
                .args_json(json!({"event":f.event,"operation":"delivery"}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        assert_eq!(
            f.view("get_custody_intent", json!({"event":f.event})).await,
            intent
        );
        assert_eq!(
            f.view("accounting", json!({})).await["delivered"],
            "0",
            "External observation cannot fabricate principal delivery"
        );
    }
    std::fs::write(
        "/cache/asset-observations-public.json",
        json!(vectors).to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn conflicting_signed_state_pauses_publication_without_rolling_back_an_existing_intent() {
    let f = Fixture::with_unobserved_custody(policy("base")).await;
    let mut receipt = f.holding_observation().await;
    f.submit_observation(&receipt).await.into_result().unwrap();
    receipt["block_hash"] = json!(format!("0x{}", id(900)));
    let paused: Value = f
        .submit_observation(&receipt)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(paused["paused"], true);
    assert!(
        f.host
            .call(f.escrow.id(), "publish")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    receipt["block_height"] = json!("101");
    let still: Value = f
        .submit_observation(&receipt)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(
        still["paused"], true,
        "A later receipt cannot silently clear a conflict"
    );
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
    assert_eq!(intent["recipient"], policy("base")["contributor"]);
    let image:Value=f.escrow.call("prepare_evm_custody").args_json(json!({"event":f.event,
        "envelope":{"nonce":0,"gas_limit":100000,"max_fee_per_gas":"2000000000","max_priority_fee_per_gas":"1000000000"}}))
        .transact().await.unwrap().into_result().unwrap().json().unwrap();
    let mut returned = f.holding_observation().await;
    returned["block_height"] = json!("102");
    returned["operation"] = json!("return");
    returned["owner"] = intent["recipient"].clone();
    returned["intent_hash"] = image["intent_hash"].clone();
    returned["image_hash"] = json!(format!(
        "{:x}",
        Sha256::digest(
            STANDARD
                .decode(image["unsigned"].as_str().unwrap())
                .unwrap()
        )
    ));
    returned["transaction"] = json!(format!("0x{}", id(2000)));
    returned["fee"] = json!("5000");
    returned["transaction_block_height"] = json!("100");
    returned["transaction_block_hash"] = returned["block_hash"].clone();
    returned["transaction_ms"] = returned["block_ms"].clone();
    let recovered: Value = f
        .submit_observation(&returned)
        .await
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(
        recovered["paused"], true,
        "Conflict must still prevent new risk"
    );
    assert_eq!(
        recovered["delivered"], true,
        "Pause must not prevent reconciliation of the already fixed return"
    );
}

#[tokio::test]
async fn observer_profile_keys_and_source_claims_are_frozen_and_separated() {
    let f = Fixture::with_unobserved_custody(policy("base")).await;
    let terms = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
    for (index, (field, value)) in [
        (
            "key",
            json!(STANDARD.encode(f.credential.verifying_key().to_bytes())),
        ),
        (
            "key",
            json!(STANDARD.encode(f.evidence.verifying_key().to_bytes())),
        ),
        (
            "key",
            json!(STANDARD.encode(f.draw.verifying_key().to_bytes())),
        ),
        ("key", json!(STANDARD.encode([1u8; 31]))),
        ("profile_hash", json!("wrong")),
        ("sources", json!(["one", "one"])),
        ("operators", json!(["same", "same"])),
        ("sources", json!(["https://unapproved", "other"])),
    ]
    .into_iter()
    .enumerate()
    {
        let mut changed = terms.clone();
        changed["event"] = json!(id(1000 + index as u64));
        changed["observer_policy"][field] = value;
        changed["rules_hash"] = json!(f.rules_commitment(&changed));
        assert!(
            f.escrow
                .call("create_event")
                .args_json(json!({"terms":changed}))
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Accepted observer policy {field}"
        );
    }
    let receipt = f.holding_observation().await;
    f.submit_observation(&receipt).await.into_result().unwrap();
    f.advance(receipt["expires_ms"].as_u64().unwrap() + 1).await;
    assert!(
        f.submit_observation(&receipt).await.is_failure(),
        "An old valid signature cannot refresh readiness"
    );
    assert!(
        f.host
            .call(f.escrow.id(), "publish")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure(),
        "Publication cannot reuse an expired holding receipt"
    );
}
