mod common;
use common::*;
use serde_json::{Value, json};

fn policy(network: &str) -> Value {
    if network == "solana" {
        let key = |number: u8| bs58::encode([number; 32]).into_string();
        json!({"network":network,"collection":key(1),"asset":key(2),"source":key(3),
            "beneficiary":key(4),"contributor":key(6),"fee_cap":"10000"})
    } else {
        json!({"network":network,"collection":format!("0x{}","11".repeat(20)),
            "asset":format!("0x{}01","00".repeat(31)),"source":format!("0x{}","22".repeat(20)),
            "beneficiary":format!("0x{}","33".repeat(20)),"contributor":format!("0x{}","44".repeat(20)),
            "fee_cap":"300000000000000"})
    }
}
fn envelope(network: &str) -> Value {
    if network == "solana" {
        json!({"blockhash":bs58::encode([5u8;32]).into_string(),"compute_units":100000,"estimated_fee":"5000","last_valid_block_height":"150"})
    } else {
        json!({"nonce":if network == "base" {0} else {256},"gas_limit":100000,"max_fee_per_gas":"2000000000","max_priority_fee_per_gas":"1000000000"})
    }
}
fn method(network: &str) -> &'static str {
    if network == "solana" {
        "prepare_solana_custody"
    } else {
        "prepare_evm_custody"
    }
}

#[tokio::test]
async fn typed_custody_construction_preserves_intent_and_rejects_mutation_or_arbitrary_callers() {
    let mut vectors = vec![];
    for network in ["base", "ethereum", "solana"] {
        let p = policy(network);
        let f = Fixture::with_custody(1, "online", 0, Some(p.clone())).await;
        assert!(
            f.escrow
                .call("lock_custody_intent")
                .args_json(json!({"event":f.event,"operation":"return"}))
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Cannot invent an early return decision"
        );
        f.host
            .call(f.escrow.id(), "cancel_or_abort")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert!(
            f.bob
                .call(f.escrow.id(), "lock_custody_intent")
                .args_json(json!({"event":f.event,"operation":"return"}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
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
        assert_eq!(intent["recipient"], p["contributor"]);
        let env = envelope(network);
        assert!(
            f.bob
                .call(f.escrow.id(), method(network))
                .args_json(json!({"event":f.event,"envelope":env}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        let image: Value = f
            .escrow
            .call(method(network))
            .args_json(json!({"event":f.event,"envelope":env}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        let repeated:Value=f.escrow.call(method(network)).args_json(json!({"event":f.event,"envelope":env,
            "recipient":"attacker","collection":"wrong","source":"wrong","asset":"wrong","operation":"delivery",
            "payload":[0,1],"path":"arbitrary","program":"wrong","chain_id":1,"value":"999999",
            "data":[0,1],"access_list":["wrong"],"signing_account":"attacker","fee_cap":"999999999999999999"}))
            .transact().await.unwrap().into_result().unwrap().json().unwrap();
        assert_eq!(
            image, repeated,
            "Caller fields cannot replace constructed signing bytes"
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
        for (field, value) in if network == "solana" {
            vec![
                ("blockhash", json!(bs58::encode([8u8; 32]).into_string())),
                ("compute_units", json!(200001)),
                ("estimated_fee", json!("10001")),
                ("last_valid_block_height", json!("151")),
            ]
        } else {
            vec![
                ("nonce", json!(8)),
                ("gas_limit", json!(100001)),
                ("max_fee_per_gas", json!("2000000001")),
                ("max_priority_fee_per_gas", json!("1000000001")),
            ]
        } {
            let mut changed = env.clone();
            changed[field] = value;
            assert!(
                f.escrow
                    .call(method(network))
                    .args_json(json!({"event":f.event,"envelope":changed}))
                    .transact()
                    .await
                    .unwrap()
                    .is_failure(),
                "Changed image must not authorize another signature"
            );
        }
        assert_eq!(
            f.view("get_custody_intent", json!({"event":f.event})).await,
            intent
        );
        vectors.push(json!({"intent":intent,"envelope":env,"image":image}));
    }
    std::fs::write(
        "/cache/custody-images-public.json",
        json!(vectors).to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn a_prescribed_delivery_intent_cannot_become_a_competing_contributor_return() {
    let f = Fixture::with_custody(1, "online", 0, Some(policy("base"))).await;
    f.close_for_draw().await;
    assert!(
        f.escrow
            .call("lock_custody_intent")
            .args_json(json!({"event":f.event,"operation":"delivery"}))
            .transact()
            .await
            .unwrap()
            .is_failure(),
        "Pending randomness cannot authorize even a fixture delivery"
    );
    f.verified_draw().await;
    let intent: Value = f
        .escrow
        .call("lock_custody_intent")
        .args_json(json!({"event":f.event,"operation":"delivery"}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(intent["recipient"], policy("base")["beneficiary"]);
    let first = f
        .escrow
        .call("prepare_evm_custody")
        .args_json(json!({"event":f.event,"envelope":envelope("base")}))
        .transact();
    let opposite = f
        .escrow
        .call("lock_custody_intent")
        .args_json(json!({"event":f.event,"operation":"return"}))
        .transact();
    let (first, opposite) = tokio::join!(first, opposite);
    assert!(first.unwrap().is_success());
    assert!(opposite.unwrap().is_failure());
    assert_eq!(
        f.view("get_custody_intent", json!({"event":f.event})).await,
        intent
    );
    assert_eq!(f.liability(110, "principal").await["total"], "5000000");
}
