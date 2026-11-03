mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn receipt(f: &Fixture, auth: &Value, time: u64, class: &str) -> Value {
    json!({"domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
        "manifest":"local-v1","event":f.event,"rules_hash":f.rules_hash,"registration":auth["registration"],
        "participant":auth["participant"],"proof_class":class,"received_ms":time,
        "nonce":id(8000),"expires_ms":(time+300_000).min(f.end-600_000)})
}

async fn snapshot(f: &Fixture, auth: &Value) -> Value {
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
    let registration = auth["registration"].as_str().unwrap();
    json!({"context":{"environment":"sandbox","deployment":f.escrow.id(),"token":f.token.id(),
        "domain":"showup.sandbox.authorization.v1","manifest":"local-v1","event":f.event,"rulesHash":f.rules_hash,
        "escrowCodeHash":bs58::encode(Sha256::digest(f.escrow.view_code().await.unwrap())).into_string(),
        "tokenCodeHash":bs58::encode(Sha256::digest(f.token.view_code().await.unwrap())).into_string(),"authorization":auth},
        "block":{"height":block.height().to_string(),"hash":block.hash().to_string(),"timestampMs":block.timestamp()/1_000_000},
        "views":{"event":read("get_event",json!({"event":f.event})).await,
            "registration":read("get_registration",json!({"registration":registration})).await,
            "principal":read("get_liability",json!({"id":format!("{registration}:principal")})).await,
            "returned":read("get_liability",json!({"id":format!("{registration}:return")})).await,
            "accounting":read("accounting",json!({})).await,"tokenBalance":balance}})
}

#[tokio::test]
async fn both_proof_classes_enforce_exact_time_bindings_and_irrevocable_principal() {
    let mut vectors = Vec::new();
    for (mode, class) in [("online", "live_code"), ("physical", "staff_qr")] {
        let f = Fixture::new(2, mode, 20_000_000).await;
        let a = f.authorization(50, f.alice.id().as_str()).await;
        let b = f.authorization(51, f.bob.id().as_str()).await;
        f.fund(&f.alice, &a, 5_000_000).await;
        f.fund(&f.bob, &b, 5_000_000).await;
        let before_a = snapshot(&f, &a).await;
        let before_b = snapshot(&f, &b).await;
        f.advance(f.start + 600_001).await;
        let early = receipt(&f, &a, f.start + 600_000, class);
        let late = receipt(&f, &b, f.start + 600_001, class);
        let bad = receipt(&f, &a, f.start - 300_001, class);
        let rejected = f
            .bob
            .call(f.escrow.id(), "accept_attendance")
            .args_json(json!({"receipt":bad,"proof":proof(&f.evidence,&bad)}))
            .transact()
            .await
            .unwrap();
        assert!(rejected.is_failure());
        for (value, expected) in [(&early, "on_time"), (&late, "late")] {
            let result = f
                .bob
                .call(f.escrow.id(), "accept_attendance")
                .args_json(json!({"receipt":value,"proof":proof(&f.evidence,value)}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
                .json::<String>()
                .unwrap();
            assert_eq!(result, expected);
        }
        let replay = f
            .bob
            .call(f.escrow.id(), "accept_attendance")
            .args_json(json!({"receipt":early,"proof":proof(&f.evidence,&early)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap();
        assert_eq!(replay, "on_time");
        assert_eq!(
            f.view("get_event", json!({"event":f.event})).await["attendance"],
            2
        );
        f.advance(f.end - 600_000 + 1).await;
        f.host
            .call(f.escrow.id(), "record_end")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let event = f.view("get_event", json!({"event":f.event})).await;
        let checkpoint = json!({"domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
            "manifest":"local-v1","event":f.event,"rules_hash":f.rules_hash,"ledger_version":event["ledger_version"],
            "complete_through_ms":f.end-900_000,"expires_ms":f.end+2_100_000});
        let closed = f
            .bob
            .call(f.escrow.id(), "close")
            .args_json(json!({"checkpoint":checkpoint,"proof":proof(&f.evidence,&checkpoint)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap();
        assert_eq!(closed, "closed");
        for number in [50, 51] {
            assert_eq!(f.liability(number, "principal").await["total"], "5000000");
            let paid = f
                .bob
                .call(f.escrow.id(), "withdraw")
                .args_json(json!({"id":format!("{}:principal",id(number))}))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
                .json::<bool>()
                .unwrap();
            assert!(paid);
        }
        assert_eq!(
            f.view("accounting", json!({})).await,
            json!({"received":"30000000","delivered":"10000000","owed":"0","unallocated":"20000000"})
        );
        assert_eq!(f.balance(f.escrow.id().as_str()).await, 20_000_000);
        for (auth, before, value, expected) in [
            (&a, before_a, &early, "on_time"),
            (&b, before_b, &late, "late"),
        ] {
            vectors.push(json!({"before":before,"receipt":value,"result":expected,
                "proof":proof(&f.evidence,value),"evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes()),
                "returned":snapshot(&f,auth).await}));
        }
        // Sponsor rewards stay unallocated for later milestones; no draw provider is needed for principal.
        assert!(
            f.host
                .call(f.escrow.id(), "cancel_or_abort")
                .args_json(json!({"event":f.event}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
    }
    std::fs::write(
        "/cache/attendance-evidence-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn missing_complete_checkpoint_aborts_without_no_show_windfall_after_hard_grace() {
    let f = Fixture::new(1, "online", 20_000_000).await;
    let auth = f.authorization(60, f.alice.id().as_str()).await;
    f.fund(&f.alice, &auth, 5_000_000).await;
    let early = f
        .bob
        .call(f.escrow.id(), "fail_neutral")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap();
    assert!(early.is_failure());
    f.advance(f.end + 2_100_000).await;
    for _ in 0..2 {
        let state = f
            .bob
            .call(f.escrow.id(), "fail_neutral")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap();
        assert_eq!(state, "aborted");
    }
    assert_eq!(f.liability(60, "principal").await["total"], "5000000");
    assert_eq!(
        f.view("get_liability", json!({"id":format!("{}:sponsor",f.event)}))
            .await["total"],
        "20000000"
    );
    assert_eq!(f.view("accounting", json!({})).await["owed"], "25000000");
    assert_eq!(f.view("accounting", json!({})).await["unallocated"], "0");
}

#[tokio::test]
async fn pre_start_cancellation_returns_all_funds_and_prevents_revival() {
    let f = Fixture::new(1, "physical", 20_000_000).await;
    let auth = f.authorization(70, f.alice.id().as_str()).await;
    f.fund(&f.alice, &auth, 5_000_000).await;
    let unauthorized = f
        .bob
        .call(f.escrow.id(), "cancel_or_abort")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap();
    assert!(unauthorized.is_failure());
    f.host
        .call(f.escrow.id(), "cancel_or_abort")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.fund(&f.alice, &auth, 5_000_000).await;
    assert_eq!(f.liability(70, "return").await["total"], "5000000");
    assert_eq!(f.view("accounting", json!({})).await["owed"], "30000000");
    assert_eq!(f.view("accounting", json!({})).await["unallocated"], "0");
    for liability in [
        format!("{}:principal", id(70)),
        format!("{}:return", id(70)),
        format!("{}:sponsor", f.event),
    ] {
        assert!(
            f.bob
                .call(f.escrow.id(), "withdraw")
                .args_json(json!({"id":liability}))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
                .json::<bool>()
                .unwrap()
        );
    }
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 0);
}
