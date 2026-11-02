mod common;
use common::*;
use near_workspaces::{Account, types::NearToken};
use serde_json::{Value, json};

async fn mint(f: &Fixture, owner: &Account, token: &str) {
    f.token
        .call("mint_nft")
        .args_json(json!({"owner_id":owner.id(),"token_id":token}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
}
async fn send(f: &Fixture, owner: &Account, token: &str, msg: String) -> bool {
    owner
        .call(f.token.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id":f.escrow.id(),"token_id":token,
        "approval_id":null,"memo":null,"msg":msg}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap()
}
async fn owner(f: &Fixture, token: &str) -> Value {
    f.token
        .view("nft_token")
        .args_json(json!({"token_id":token}))
        .await
        .unwrap()
        .json::<Value>()
        .unwrap()["owner_id"]
        .clone()
}
async fn deposit(f: &Fixture) {
    mint(f, &f.alice, "prize-1").await;
    assert!(send(f, &f.alice, "prize-1", json!({"event":f.event}).to_string()).await);
    assert_eq!(owner(f, "prize-1").await, json!(f.escrow.id()));
}

#[tokio::test]
async fn native_nft_receipt_gates_publication_and_failed_delivery_preserves_exact_intent() {
    let f = Fixture::with_native().await;
    assert!(
        f.host
            .call(f.escrow.id(), "publish")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    // A direct caller, wrong token, wrong owner, wrong event or malformed message cannot manufacture custody.
    let fake:bool=f.alice.call(f.escrow.id(),"nft_on_transfer").args_json(json!({"sender_id":f.alice.id(),
        "previous_owner_id":f.alice.id(),"token_id":"prize-1","msg":json!({"event":f.event}).to_string()}))
        .transact().await.unwrap().into_result().unwrap().json().unwrap();
    assert!(fake);
    assert!(
        f.view("get_native_prize", json!({"event":f.event}))
            .await
            .is_null()
    );
    mint(&f, &f.alice, "other").await;
    assert!(!send(&f, &f.alice, "other", json!({"event":f.event}).to_string()).await);
    assert_eq!(owner(&f, "other").await, json!(f.alice.id()));
    mint(&f, &f.bob, "prize-1").await;
    assert!(!send(&f, &f.bob, "prize-1", json!({"event":f.event}).to_string()).await);
    assert_eq!(owner(&f, "prize-1").await, json!(f.bob.id()));
    f.bob
        .call(f.token.id(), "nft_transfer")
        .args_json(
            json!({"receiver_id":f.alice.id(),"token_id":"prize-1","approval_id":null,"memo":null}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    for msg in [json!({"event":id(999)}).to_string(), "invalid".into()] {
        assert!(!send(&f, &f.alice, "prize-1", msg).await);
        assert_eq!(owner(&f, "prize-1").await, json!(f.alice.id()));
    }
    assert!(
        send(
            &f,
            &f.alice,
            "prize-1",
            json!({"event":f.event}).to_string()
        )
        .await
    );
    f.host
        .call(f.escrow.id(), "publish")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.close_for_draw().await;
    f.verified_draw().await;
    assert!(
        f.bob
            .call(f.escrow.id(), "lock_native_delivery")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.escrow
        .call("lock_native_delivery")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.token
        .call("set_fail_nft")
        .args_json(json!({"fail":true}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let failed: bool = f
        .bob
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap();
    assert!(!failed);
    assert_eq!(owner(&f, "prize-1").await, json!(f.escrow.id()));
    let state = f.view("get_native_prize", json!({"event":f.event})).await;
    assert_eq!(state["held"], true);
    assert_eq!(state["pending"], false);
    assert_eq!(state["intent"]["recipient"], json!(f.bob.id()));
    assert!(
        f.host
            .call(f.escrow.id(), "recover_native_return")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.token
        .call("set_fail_nft")
        .args_json(json!({"fail":false}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.token
        .call("set_reply_size")
        .args_json(json!({"bytes":8192}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let first = f
        .alice
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact();
    let second = f
        .bob
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact();
    let (first, second) = tokio::join!(first, second);
    assert_eq!(
        usize::from(first.unwrap().is_success()) + usize::from(second.unwrap().is_success()),
        1
    );
    assert_eq!(owner(&f, "prize-1").await, json!(f.bob.id()));
    let state = f.view("get_native_prize", json!({"event":f.event})).await;
    assert_eq!(state["delivered"], true);
    assert_eq!(state["held"], false);
    assert_eq!(state["attempts"], 2);
    assert!(
        f.alice
            .call(f.escrow.id(), "on_native_nft")
            .args_json(json!({"event":f.event,"attempt":1}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    assert!(
        f.bob
            .call(f.escrow.id(), "deliver_native_nft")
            .args_json(json!({"event":f.event}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    assert_eq!(f.liability(110, "principal").await["total"], "5000000");
}

#[tokio::test]
async fn unpublished_draft_cancellation_returns_actual_nft_and_sponsor_funds() {
    let f = Fixture::with_native().await;
    deposit(&f).await;
    f.host
        .call(f.escrow.id(), "cancel_or_abort")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let state = f.view("get_native_prize", json!({"event":f.event})).await;
    assert_eq!(state["intent"]["operation"], "return");
    assert_eq!(state["intent"]["recipient"], json!(f.alice.id()));
    f.bob
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(owner(&f, "prize-1").await, json!(f.alice.id()));
    f.bob
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":format!("{}:sponsor",f.event)}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(f.balance(f.host.id().as_str()).await, 100_000_000);
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"20000000","delivered":"20000000","owed":"0","unallocated":"0"})
    );
    assert!(
        !send(
            &f,
            &f.alice,
            "prize-1",
            json!({"event":f.event}).to_string()
        )
        .await,
        "Closed event cannot accept a new contribution"
    );
    assert!(
        f.host
            .call(f.escrow.id(), "publish")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
}

#[tokio::test]
async fn abandoned_funded_draft_recovers_all_assets_after_hard_grace_without_host() {
    let f = Fixture::with_native().await;
    deposit(&f).await;
    assert!(
        f.bob
            .call(f.escrow.id(), "fail_neutral")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.advance(f.end + 2_100_000).await;
    f.bob
        .call(f.escrow.id(), "fail_neutral")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["status"],
        "aborted"
    );
    f.bob
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(owner(&f, "prize-1").await, json!(f.alice.id()));
    assert_eq!(
        f.view("get_liability", json!({"id":format!("{}:sponsor",f.event)}))
            .await["total"],
        "20000000"
    );
}

#[tokio::test]
async fn original_draw_timeout_automatically_preserves_the_native_contributor_return() {
    let f = Fixture::with_native().await;
    deposit(&f).await;
    f.host
        .call(f.escrow.id(), "publish")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.close_for_draw().await;
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
    f.advance(frozen["deadline_ms"].as_u64().unwrap()).await;
    f.bob
        .call(f.escrow.id(), "timeout_draw_proof")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let prize = f.view("get_native_prize", json!({"event":f.event})).await;
    assert_eq!(prize["intent"]["recipient"], json!(f.alice.id()));
    f.bob
        .call(f.escrow.id(), "deliver_native_nft")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(owner(&f, "prize-1").await, json!(f.alice.id()));
    assert!(
        f.escrow
            .call("lock_native_delivery")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    assert_eq!(f.liability(110, "principal").await["total"], "5000000");
}
