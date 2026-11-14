mod common;
use common::*;
use near_workspaces::types::CryptoHash;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn view_at(f: &Fixture, method: &str, args: Value, block: CryptoHash) -> Value {
    f.escrow
        .view(method)
        .args_json(args)
        .block_hash(block)
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn snapshot(f: &Fixture, context: &Value, stage: &str) -> Value {
    let block = f.worker.view_block().await.unwrap();
    let hash = *block.hash();
    let registration = &context["authorization"]["registration"];
    let balance: String = f
        .token
        .view("ft_balance_of")
        .args_json(json!({"account_id":f.escrow.id()}))
        .block_hash(hash)
        .await
        .unwrap()
        .json()
        .unwrap();
    json!({"stage":stage,"context":context,
        "block":{"height":block.height().to_string(),"hash":block.hash().to_string(),"timestampMs":block.timestamp()/1_000_000},
        "views":{
            "event":view_at(f,"get_event",json!({"event":f.event}),hash).await,
            "registration":view_at(f,"get_registration",json!({"registration":registration}),hash).await,
            "principal":view_at(f,"get_liability",json!({"id":format!("{}:principal",registration.as_str().unwrap())}),hash).await,
            "returned":view_at(f,"get_liability",json!({"id":format!("{}:return",registration.as_str().unwrap())}),hash).await,
            "accounting":view_at(f,"accounting",json!({}),hash).await,
            "tokenBalance":balance}})
}

#[tokio::test]
async fn settlement_views_replay_actual_receipts_capacity_and_failed_refund_recovery() {
    let f = Fixture::new(1, "online", 0).await;
    let recipient = f.worker.dev_create_account().await.unwrap();
    let mut auth = f.authorization(500, f.alice.id().as_str()).await;
    auth["payout"] = f.destination(recipient.id().as_str());
    let context = json!({"environment":"sandbox","deployment":f.escrow.id(),"token":f.token.id(),
        "domain":"showup.sandbox.authorization.v1","manifest":"local-v1","event":f.event,"rulesHash":f.rules_hash,
        "escrowCodeHash":bs58::encode(Sha256::digest(f.escrow.view_code().await.unwrap())).into_string(),
        "tokenCodeHash":bs58::encode(Sha256::digest(f.token.view_code().await.unwrap())).into_string(),
        "authorization":auth});
    let mut vectors = vec![snapshot(&f, &context, "absent").await];
    f.bob
        .call(f.escrow.id(), "reserve")
        .args_json(json!({"authorization":auth,"proof":proof(&f.credential,&auth)}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    vectors.push(snapshot(&f, &context, "reserved").await);
    f.fund(&f.alice, &auth, 2_000_000).await;
    vectors.push(snapshot(&f, &context, "short_return").await);
    f.fund(&f.alice, &auth, 6_000_000).await;
    vectors.push(snapshot(&f, &context, "funded_excess").await);
    f.fund(&f.alice, &auth, 5_000_000).await;
    vectors.push(snapshot(&f, &context, "duplicate_return").await);
    f.release(&auth).await;
    vectors.push(snapshot(&f, &context, "released").await);
    f.bob
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"id":format!("{}:principal",id(500))}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(f.liability(500, "principal").await["paid"], "0");
    vectors.push(snapshot(&f, &context, "failed_principal").await);
    f.token
        .call("register")
        .args_json(json!({"account":recipient.id()}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    for kind in ["principal", "return"] {
        f.bob
            .call(f.escrow.id(), "withdraw")
            .args_json(json!({"id":format!("{}:{kind}",id(500))}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        vectors.push(snapshot(&f, &context, &format!("paid_{kind}")).await);
    }
    assert_eq!(f.balance(recipient.id().as_str()).await, 5_000_000);
    assert_eq!(f.balance(f.escrow.id().as_str()).await, 0);
    assert_eq!(f.liability(500, "return").await["paid"], "8000000");
    std::fs::write(
        "/cache/settlement-state-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}
