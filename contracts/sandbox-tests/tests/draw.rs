mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use ed25519_dalek::Signer;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn closed_fixture() -> Fixture {
    let f = Fixture::new(1, "online", 20_000_000).await;
    f.close_for_draw().await;
    f
}

async fn bind(f: &Fixture) -> Value {
    let frozen: Value = f
        .escrow
        .call("freeze_draw_proof")
        .args_json(json!({"event":f.event,"snapshot_hash":id(9200)}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    let bound: Value = f
        .escrow
        .call("bind_draw_proof")
        .args_json(json!({"event":f.event,"snapshot_hash":id(9200),"request_id":"original-42"}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(bound["created_ms"], frozen["created_ms"]);
    assert_eq!(bound["deadline_ms"], frozen["deadline_ms"]);
    bound
}
fn result(f: &Fixture, binding: &Value) -> Value {
    let alpha = binding["alpha"].as_str().unwrap();
    let signature = f.draw.sign(alpha.as_bytes()).to_bytes();
    json!({"event":f.event,"alpha":alpha,"signature":STANDARD.encode(signature),"output":format!("{:x}",Sha256::digest(signature))})
}

#[tokio::test]
async fn original_request_seed_key_and_exclusive_result_are_verified_on_chain() {
    let f = closed_fixture().await;
    let unauthorized = f
        .bob
        .call(f.escrow.id(), "bind_draw_proof")
        .args_json(json!({"event":f.event,"snapshot_hash":id(9200),"request_id":"original-42"}))
        .transact()
        .await
        .unwrap();
    assert!(unauthorized.is_failure());
    let binding = bind(&f).await;
    let rejected_freeze = f
        .escrow
        .call("freeze_draw_proof")
        .args_json(json!({"event":f.event,"snapshot_hash":id(9999)}))
        .transact()
        .await
        .unwrap();
    assert!(rejected_freeze.is_failure(), "Snapshot cannot be replaced");
    // Independent Rust implementation reproduces the contract's seed and alpha.
    let context = json!({"domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
        "manifest":"local-v1","event":f.event,"rules_hash":f.rules_hash,"snapshot_hash":id(9200),"round":0,
        "exclusion_hash":format!("{:x}",Sha256::digest(b"[]")),"provider":"outlayer.local",
        "project":"showup.local/vrf-test","version_hash":id(9300),"sender":f.escrow.id(),"key":STANDARD.encode(f.draw.verifying_key().to_bytes())});
    let seed = format!("{:x}", Sha256::digest(context.to_string()));
    assert_eq!(binding["seed"], seed);
    assert_eq!(
        binding["alpha"],
        format!("vrf:original-42:{}:{seed}", f.escrow.id())
    );
    let valid = result(&f, &binding);
    let replay_signature = STANDARD
        .decode(valid["signature"].as_str().unwrap())
        .unwrap()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let replay = json!({"context":context,"requestId":"original-42","alpha":valid["alpha"],
        "signature":replay_signature,
        "output":valid["output"]});
    let mut wrong_key = valid.clone();
    wrong_key["signature"] = json!(
        STANDARD.encode(
            f.credential
                .sign(binding["alpha"].as_str().unwrap().as_bytes())
                .to_bytes()
        )
    );
    assert!(
        f.bob
            .call(f.escrow.id(), "accept_draw_proof")
            .args_json(wrong_key)
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    for alpha in [
        format!("vrf:different:{}:{seed}", f.escrow.id()),
        format!("vrf:original-42:{}:{seed}", f.alice.id()),
        format!("vrf:original-42:{}:{}", f.escrow.id(), id(9999)),
    ] {
        let signature = f.draw.sign(alpha.as_bytes()).to_bytes();
        let changed = json!({"event":f.event,"alpha":alpha,"signature":STANDARD.encode(signature),
            "output":format!("{:x}",Sha256::digest(signature))});
        assert!(
            f.bob
                .call(f.escrow.id(), "accept_draw_proof")
                .args_json(changed)
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "A cryptographically valid proof for another binding must fail"
        );
    }
    for (key, value) in [
        ("event", json!(id(999))),
        (
            "alpha",
            json!(format!("vrf:different:{}:{seed}", f.escrow.id())),
        ),
        ("output", json!(id(1))),
        ("signature", json!(STANDARD.encode([0u8; 64]))),
    ] {
        let mut changed = valid.clone();
        changed[key] = value;
        assert!(
            f.bob
                .call(f.escrow.id(), "accept_draw_proof")
                .args_json(changed)
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
    }
    let accounting = f.view("accounting", json!({})).await;
    for _ in 0..2 {
        let state: Value = f
            .bob
            .call(f.escrow.id(), "accept_draw_proof")
            .args_json(valid.clone())
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(state["state"], "verified");
    }
    // Public disposable fixture only, for independent native-Node replay in CI.
    std::fs::write("/cache/draw-proof-public.json", replay.to_string()).unwrap();
    f.advance(binding["deadline_ms"].as_u64().unwrap() + 1)
        .await;
    let state: Value = f
        .bob
        .call(f.escrow.id(), "timeout_draw_proof")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(state["state"], "verified");
    assert_eq!(
        accounting,
        f.view("accounting", json!({})).await,
        "Proof does not allocate or delay principal"
    );
    assert!(
        f.escrow
            .call("bind_draw_proof")
            .args_json(json!({"event":f.event,"snapshot_hash":id(9201),"request_id":"reroll"}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
}

#[tokio::test]
async fn bounded_same_request_recovery_cannot_reset_or_revive_a_timed_out_round() {
    let f = closed_fixture().await;
    let binding = bind(&f).await;
    let valid = result(&f, &binding);
    assert!(
        f.bob
            .call(f.escrow.id(), "recover_draw_proof")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    let created = binding["created_ms"].as_u64().unwrap();
    for (offset, attempts) in [(15_000, 2), (45_000, 3)] {
        f.advance(created + offset + 1).await;
        let state: Value = f
            .bob
            .call(f.escrow.id(), "recover_draw_proof")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(state["attempts"], attempts);
        for key in [
            "request_id",
            "seed",
            "alpha",
            "created_ms",
            "deadline_ms",
            "snapshot_hash",
        ] {
            assert_eq!(state[key], binding[key]);
        }
    }
    assert!(
        f.bob
            .call(f.escrow.id(), "recover_draw_proof")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    assert!(
        f.bob
            .call(f.escrow.id(), "timeout_draw_proof")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.advance(binding["deadline_ms"].as_u64().unwrap()).await;
    let timeout = f
        .bob
        .call(f.escrow.id(), "timeout_draw_proof")
        .args_json(json!({"event":f.event}))
        .transact();
    let late = f
        .alice
        .call(f.escrow.id(), "accept_draw_proof")
        .args_json(valid)
        .transact();
    let (timeout, late) = tokio::join!(timeout, late);
    assert!(timeout.unwrap().is_success());
    assert!(late.unwrap().is_failure());
    assert_eq!(
        f.view("get_draw_proof", json!({"event":f.event})).await["state"],
        "timed_out"
    );
    assert_eq!(f.liability(110, "principal").await["total"], "5000000");
    assert_eq!(
        f.view("accounting", json!({})).await["unallocated"],
        "20000000"
    );
}

#[tokio::test]
async fn unknown_original_submission_cannot_extend_the_overall_deadline() {
    let f = closed_fixture().await;
    let frozen: Value = f
        .escrow
        .call("freeze_draw_proof")
        .args_json(json!({"event":f.event,"snapshot_hash":id(9200)}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(frozen["state"], "awaiting_request");
    f.advance(frozen["deadline_ms"].as_u64().unwrap() + 1).await;
    assert!(
        f.escrow
            .call("bind_draw_proof")
            .args_json(json!({"event":f.event,"request_id":"late-original"}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    let state: Value = f
        .bob
        .call(f.escrow.id(), "timeout_draw_proof")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(state["state"], "timed_out");
    assert_eq!(state["deadline_ms"], frozen["deadline_ms"]);
    assert!(
        f.escrow
            .call("freeze_draw_proof")
            .args_json(json!({"event":f.event,"snapshot_hash":id(9999)}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
}
