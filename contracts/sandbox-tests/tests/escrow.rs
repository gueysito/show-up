mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use serde_json::json;

#[tokio::test]
async fn rules_hash_is_recomputed_from_the_complete_frozen_terms() {
    let f = Fixture::with_native().await;
    let mut terms = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
    terms["event"] = json!(id(9900));
    terms["rules_hash"] = json!(id(9901));
    let result = f
        .escrow
        .call("create_event")
        .args_json(json!({"terms":terms}))
        .transact()
        .await
        .unwrap();
    assert!(
        result.is_failure(),
        "Contract accepted a rules hash unrelated to its material terms"
    );
    terms["rules_hash"] = json!(f.rules_commitment(&terms));
    let independent: String = f
        .escrow
        .view("compute_rules_hash")
        .args_json(json!({"terms":terms}))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(terms["rules_hash"], independent);
    let mut variants = vec![];
    for (field, value) in [
        ("event", json!(id(9902))),
        ("host", json!(f.bob.id())),
        ("mode", json!("physical")),
        ("capacity", json!(2)),
        ("principal", json!("6000000")),
        ("sponsor_budget", json!("10000000")),
        ("sponsor_return", f.destination(f.bob.id().as_str())),
        ("start_ms", json!(f.start - 60_000)),
        ("end_ms", json!(f.end + 60_000)),
        ("latest_quiz_close_ms", json!(f.start + 600_000)),
        ("excluded", json!([id(9991)])),
        (
            "custody_proof_policy",
            json!({"network":"base","collection":format!("0x{}","11".repeat(20)),
            "asset":format!("0x{}01","00".repeat(31)),"source":format!("0x{}","22".repeat(20)),
            "beneficiary":format!("0x{}","33".repeat(20)),"contributor":format!("0x{}","44".repeat(20)),"fee_cap":"300000000000000"}),
        ),
    ] {
        let mut changed = terms.clone();
        changed[field] = value;
        variants.push((field.to_string(), changed));
    }
    for (field, value) in [
        ("token", json!(f.escrow.id())),
        ("token_id", json!("different")),
        ("contributor", json!(f.host.id())),
        ("fixture_beneficiary", json!(f.token.id())),
    ] {
        let mut changed = terms.clone();
        changed["native_nft"][field] = value;
        variants.push((format!("native_nft.{field}"), changed));
    }
    for (field, value) in [
        ("provider", json!(f.token.id())),
        ("project", json!("other.local/project")),
        ("version_hash", json!(id(9993))),
        ("sender", json!(f.bob.id())),
        ("key", json!(STANDARD.encode([9u8; 32]))),
    ] {
        let mut changed = terms.clone();
        changed["draw_policy"][field] = value;
        variants.push((format!("draw_policy.{field}"), changed));
    }
    for (field, changed) in variants {
        let result = f
            .escrow
            .call("create_event")
            .args_json(json!({"terms":changed}))
            .transact()
            .await
            .unwrap();
        assert!(result.is_failure(), "Uncommitted field accepted: {field}");
        let message = result
            .into_result()
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();
        assert!(
            message.contains("Rules hash does not match frozen terms"),
            "Wrong rejection for {field}"
        );
    }
    f.escrow
        .call("create_event")
        .args_json(json!({"terms":terms}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(
        f.view("get_event", json!({"event":id(9900)})).await["terms"]["rules_hash"],
        independent
    );
}

#[tokio::test]
async fn actual_funding_wallet_cannot_be_substituted_or_aliased_to_take_two_seats() {
    let f = Fixture::new(2, "online", 0).await;
    let auth = f.authorization(90, f.alice.id().as_str()).await;
    assert_eq!(f.fund(&f.bob, &auth, 5_000_000).await, "0");
    assert!(
        f.view("get_registration", json!({"registration":id(90)}))
            .await
            .is_null()
    );
    f.fund(&f.alice, &auth, 5_000_000).await;
    let alias = f.authorization(91, f.alice.id().as_str()).await;
    f.fund(&f.alice, &alias, 5_000_000).await;
    assert_eq!(f.liability(91, "return").await["total"], "5000000");
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["funded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.balance(f.bob.id().as_str()).await, 100_000_000);
}

#[tokio::test]
async fn competing_withdrawals_and_large_success_bodies_cannot_duplicate_payment() {
    let f = Fixture::new(1, "online", 0).await;
    let auth = f.authorization(80, f.alice.id().as_str()).await;
    f.fund(&f.alice, &auth, 5_000_000).await;
    f.release(&auth).await;
    f.token
        .call("set_reply_size")
        .args_json(json!({"bytes":8192}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let id = format!("{}:principal", id(80));
    let first = f
        .alice
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":id}))
        .max_gas()
        .transact();
    let second = f
        .bob
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":id}))
        .max_gas()
        .transact();
    let (a, b) = tokio::join!(first, second);
    assert_eq!(
        usize::from(a.unwrap().is_success()) + usize::from(b.unwrap().is_success()),
        1
    );
    assert_eq!(f.balance(f.alice.id().as_str()).await, 100_000_000);
    assert_eq!(f.liability(80, "principal").await["paid"], "5000000");
    assert_eq!(
        f.view("accounting", json!({})).await["delivered"],
        "5000000"
    );
}

#[tokio::test]
async fn exclusions_and_duplicate_wallet_credentials_cannot_take_another_seat() {
    let f = Fixture::new(2, "online", 0).await;
    let mut excluded = f.authorization(75, f.alice.id().as_str()).await;
    excluded["participant"] = json!(id(9990));
    f.fund(&f.alice, &excluded, 5_000_000).await;
    assert_eq!(f.liability(75, "return").await["total"], "5000000");
    let original = f.authorization(76, f.alice.id().as_str()).await;
    f.fund(&f.alice, &original, 5_000_000).await;
    let mut duplicate = f.authorization(77, f.bob.id().as_str()).await;
    duplicate["wallet_tag"] = original["wallet_tag"].clone();
    f.fund(&f.bob, &duplicate, 5_000_000).await;
    assert_eq!(f.liability(77, "return").await["total"], "5000000");
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["funded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn actual_token_receipt_binds_seat_and_preserves_short_excess_duplicate_returns() {
    let f = Fixture::new(1, "online", 0).await;
    let auth = f.authorization(10, f.alice.id().as_str()).await;
    assert_eq!(f.fund(&f.alice, &auth, 2_000_000).await, "2000000");
    assert_eq!(
        f.view("get_registration", json!({"registration":id(10)}))
            .await["state"],
        "return_only"
    );
    assert_eq!(f.fund(&f.alice, &auth, 6_000_000).await, "6000000");
    assert_eq!(
        f.view("get_registration", json!({"registration":id(10)}))
            .await["state"],
        "funded"
    );
    f.fund(&f.alice, &auth, 5_000_000).await;
    assert_eq!(f.liability(10, "return").await["total"], "8000000");
    assert_eq!(
        f.view("get_event", json!({"event":f.event})).await["funded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"13000000","delivered":"0","owed":"8000000","unallocated":"5000000"})
    );
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 13_000_000);
}

#[tokio::test]
async fn hostile_fields_and_fake_token_callbacks_cannot_create_seats_or_debt() {
    let f = Fixture::new(1, "online", 0).await;
    let auth = f.authorization(20, f.alice.id().as_str()).await;
    let signature = proof(&f.credential, &auth);
    for (field, value) in [
        ("domain", json!("wrong")),
        ("deployment", json!(f.token.id())),
        ("manifest", json!("wrong")),
        ("event", json!(id(999))),
        ("rules_hash", json!(id(999))),
        ("participant", json!(id(999))),
        ("principal", json!("1")),
        ("nonce", json!(id(999))),
        ("expires_ms", json!(0)),
        ("payout", f.destination(f.bob.id().as_str())),
        ("refund", f.destination(f.bob.id().as_str())),
        ("fee_cap", json!("200000")),
    ] {
        let mut changed = auth.clone();
        changed[field] = value;
        let result = f
            .transfer(
                &f.alice,
                5_000_000,
                json!({"kind":"commitment","authorization":changed,"proof":signature}),
            )
            .await;
        assert_eq!(result, "0", "Altered {field} was accepted");
    }
    let callback=f.alice.call(f.escrow.id(),"ft_on_transfer").args_json(json!({"sender_id":f.alice.id(),
        "amount":"5000000","msg":json!({"kind":"commitment","authorization":auth,"proof":signature}).to_string()}))
        .transact().await.unwrap();
    assert!(callback.is_failure());
    assert_eq!(f.balance(f.alice.id().as_str()).await, 100_000_000);
    assert_eq!(f.view("accounting", json!({})).await["received"], "0");
    assert!(
        f.view("get_registration", json!({"registration":id(20)}))
            .await
            .is_null()
    );
    // Prove the negative vectors fail because of their mutations/caller, rather
    // than an unconfigured receiver: the identical original payload must fund.
    assert_eq!(f.fund(&f.alice, &auth, 5_000_000).await, "5000000");
    assert_eq!(
        f.view("get_registration", json!({"registration":id(20)}))
            .await["state"],
        "funded"
    );
}

#[tokio::test]
async fn expired_reservation_last_seat_race_and_late_funding_conserve_all_principal() {
    let f = Fixture::new(1, "online", 0).await;
    let a = f.authorization(30, f.alice.id().as_str()).await;
    f.alice
        .call(f.escrow.id(), "reserve")
        .args_json(json!({"authorization":a,"proof":proof(&f.credential,&a)}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    f.advance(a["reservation_ms"].as_u64().unwrap() + 1).await;
    let b = f.authorization(31, f.bob.id().as_str()).await;
    let (first, second) = tokio::join!(
        f.fund(&f.alice, &a, 5_000_000),
        f.fund(&f.bob, &b, 5_000_000)
    );
    assert_eq!(first, "5000000");
    assert_eq!(second, "5000000");
    let event = f.view("get_event", json!({"event":f.event})).await;
    assert_eq!(event["funded"].as_array().unwrap().len(), 1);
    assert_eq!(f.view("accounting", json!({})).await["owed"], "5000000");
    let c = f.authorization(32, f.alice.id().as_str()).await;
    f.advance(f.start + 1).await;
    // A valid signed authorization that expired at cutoff creates a return, never a seat.
    f.fund(&f.alice, &c, 5_000_000).await;
    assert_eq!(f.liability(32, "return").await["total"], "5000000");
    assert_eq!(
        f.view("accounting", json!({})).await["received"],
        "15000000"
    );
}

#[tokio::test]
async fn failed_native_delivery_restores_debt_and_retry_cannot_pay_twice_or_redirect() {
    let f = Fixture::new(1, "online", 0).await;
    let recipient = f.worker.dev_create_account().await.unwrap();
    let mut auth = f.authorization(40, recipient.id().as_str()).await;
    auth["source"] = f.destination(f.alice.id().as_str());
    f.fund(&f.alice, &auth, 5_000_000).await;
    f.release(&auth).await;
    let liability = format!("{}:principal", id(40));
    let fake = f
        .bob
        .call(f.escrow.id(), "on_transfer")
        .args_json(json!({"id":liability,"number":1,"amount":"5000000"}))
        .transact()
        .await
        .unwrap();
    assert!(fake.is_failure());
    let outcome = f
        .bob
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":liability}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json::<bool>()
        .unwrap();
    assert!(!outcome);
    let unpaid = f.liability(40, "principal").await;
    assert_eq!(unpaid["paid"], "0");
    assert!(unpaid["pending"].is_null());
    f.token
        .call("register")
        .args_json(json!({"account":recipient.id()}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let delivered = f
        .alice
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":liability}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json::<bool>()
        .unwrap();
    assert!(delivered);
    assert_eq!(f.balance(recipient.id().as_str()).await, 5_000_000);
    let repeat = f
        .alice
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":liability}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(repeat.is_failure());
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"5000000","delivered":"5000000","owed":"0","unallocated":"0"})
    );
}
