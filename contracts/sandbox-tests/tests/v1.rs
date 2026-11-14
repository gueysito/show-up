mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use near_workspaces::operations::Function;
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

struct V1 {
    worker: Worker<Sandbox>,
    escrow: Contract,
    token: Contract,
    host: Account,
    alice: Account,
    bob: Account,
    carol: Account,
    start: u64,
    _node: near_sandbox::Sandbox,
}

impl V1 {
    async fn new() -> Self {
        let (worker, node) = common::start_node().await;
        let wasm = "/cache/target/wasm32-unknown-unknown/release";
        let escrow = worker
            .dev_deploy(&std::fs::read(format!("{wasm}/showup_v1.wasm")).unwrap())
            .await
            .unwrap();
        let token = worker
            .dev_deploy(&std::fs::read(format!("{wasm}/showup_test_token.wasm")).unwrap())
            .await
            .unwrap();
        let host = worker.dev_create_account().await.unwrap();
        let alice = worker.dev_create_account().await.unwrap();
        let bob = worker.dev_create_account().await.unwrap();
        let carol = worker.dev_create_account().await.unwrap();
        token
            .call("new")
            .args_json(json!({}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        escrow
            .call("new")
            .args_json(json!({"owner":host.id(),"token":token.id(),"signer":token.id()}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        for a in [escrow.id(), host.id(), alice.id(), bob.id(), carol.id()] {
            token
                .call("register")
                .args_json(json!({"account":a}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
            if a != escrow.id() {
                token
                    .call("mint")
                    .args_json(json!({"account":a,"amount":"100000000"}))
                    .transact()
                    .await
                    .unwrap()
                    .into_result()
                    .unwrap();
            }
        }
        let start = worker.view_block().await.unwrap().timestamp() / 1_000_000 + 60_000;
        Self {
            worker,
            escrow,
            token,
            host,
            alice,
            bob,
            carol,
            start,
            _node: node,
        }
    }
    async fn call(&self, method: &str, args: Value) -> Value {
        let result = self
            .host
            .call(self.escrow.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .raw_bytes()
            .unwrap();
        if result.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&result).unwrap()
        }
    }
    async fn view(&self, method: &str, args: Value) -> Value {
        self.escrow
            .view(method)
            .args_json(args)
            .await
            .unwrap()
            .json()
            .unwrap()
    }
    async fn balance(&self, account: &Account) -> u128 {
        let x: String = self
            .token
            .view("ft_balance_of")
            .args_json(json!({"account_id":account.id()}))
            .await
            .unwrap()
            .json()
            .unwrap();
        x.parse().unwrap()
    }
    async fn event(&self, event: &str, deposit: u128, prize: u128, nft: Option<Value>) {
        self.call("create_event",json!({"terms":{"id":event,"title":"Local V1 event","start_ms":self.start,"end_ms":self.start+600_000,
            "capacity":4,"deposit":deposit.to_string(),"prize":prize.to_string(),"sponsor":self.host.id(),"nft":nft}})).await;
    }
    async fn register(&self, id: &str, event: &str, account: &Account, payout: &Account) {
        self.call("register",json!({"id":id,"event":event,"sender":account.id(),"payout":payout.id(),"ethereum":format!("0x{}","22".repeat(20))})).await;
    }
    async fn fund(&self, account: &Account, amount: u128, msg: &str) -> String {
        account
            .call(self.token.id(), "ft_transfer_call")
            .args_json(
                json!({"receiver_id":self.escrow.id(),"amount":amount.to_string(),"msg":msg}),
            )
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
    async fn advance(&self) {
        for _ in 0..8 {
            let current = self.worker.view_block().await.unwrap().timestamp() / 1_000_000;
            if current >= self.start {
                return;
            }
            self.worker
                .fast_forward((self.start - current).div_ceil(310) + 2)
                .await
                .unwrap();
        }
        panic!("Sandbox clock did not advance");
    }
    async fn mock(&self, configuration: Value) {
        self.token
            .call("configure_signer")
            .args_json(json!({"configuration":configuration}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }
}

#[tokio::test]
async fn v1_native_prize_rejects_wrong_sender_amount_and_duplicate_without_losing_usdc() {
    let f = V1::new().await;
    f.event("prize-guard", 1_000_000, 1_000_000, None).await;
    assert_eq!(f.fund(&f.alice, 1_000_000, "prize:prize-guard").await, "0");
    assert_eq!(f.fund(&f.host, 999_999, "prize:prize-guard").await, "0");
    assert_eq!(f.balance(&f.alice).await, 100_000_000);
    assert_eq!(f.balance(&f.host).await, 100_000_000);
    assert_eq!(
        f.view("get_event", json!({"event":"prize-guard"})).await["prize_received"],
        false
    );
    assert_eq!(
        f.fund(&f.host, 1_000_000, "prize:prize-guard").await,
        "1000000"
    );
    assert_eq!(f.fund(&f.host, 1_000_000, "prize:prize-guard").await, "0");
    assert_eq!(f.balance(&f.host).await, 99_000_000);
    f.call("publish", json!({"event":"prize-guard"})).await;
    f.call("cancel", json!({"event":"prize-guard"})).await;
    f.call("withdraw", json!({"claim":"prize:prize-guard"}))
        .await;
    assert_eq!(f.balance(&f.host).await, 100_000_000);
}

#[tokio::test]
async fn v1_real_receipt_cancel_and_fixed_beneficiary_refund() {
    let f = V1::new().await;
    f.event("cancel", 2_000_000, 0, None).await;
    f.call("publish", json!({"event":"cancel"})).await;
    assert!(f.host.call(f.escrow.id(),"register").args_json(json!({"id":"host","event":"cancel","sender":f.host.id(),"payout":f.host.id(),"ethereum":null})).transact().await.unwrap().is_failure(), "Host could register to receive forfeitures");
    f.register("alice", "cancel", &f.alice, &f.alice).await;
    assert_eq!(f.fund(&f.bob, 2_000_000, "deposit:alice").await, "0");
    assert_eq!(
        f.fund(&f.alice, 1_000_000, "deposit:alice").await,
        "1000000"
    );
    assert!(
        !f.view("get_registration", json!({"registration":"alice"}))
            .await["funded"]
            .as_bool()
            .unwrap()
    );
    f.call("withdraw", json!({"claim":"recovery:alice"})).await;
    assert_eq!(f.balance(&f.alice).await, 100_000_000);
    let forged = f
        .alice
        .call(f.escrow.id(), "ft_on_transfer")
        .args_json(json!({"sender_id":f.alice.id(),"amount":"2000000","msg":"deposit:alice"}))
        .transact()
        .await
        .unwrap();
    assert!(forged.is_failure());
    assert_eq!(
        f.fund(&f.alice, 2_000_000, "deposit:alice").await,
        "2000000"
    );
    assert_eq!(
        f.fund(&f.alice, 2_000_000, "deposit:alice").await,
        "2000000"
    );
    f.call("withdraw", json!({"claim":"recovery:alice"})).await;
    assert_eq!(f.balance(&f.alice).await, 98_000_000);
    assert!(
        f.bob
            .call(f.escrow.id(), "cancel")
            .args_json(json!({"event":"cancel"}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.call("cancel", json!({"event":"cancel"})).await;
    // Anyone can relay withdrawal, but cannot replace the stored beneficiary.
    f.bob
        .call(f.escrow.id(), "withdraw")
        .args_json(json!({"claim":"alice"}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(f.balance(&f.alice).await, 100_000_000);
    assert_eq!(f.balance(&f.bob).await, 100_000_000);
    assert!(
        f.alice
            .call(f.escrow.id(), "withdraw")
            .args_json(json!({"claim":"alice"}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"5000000","paid":"5000000","held":"0"})
    );
}

#[tokio::test]
async fn v1_forfeitures_equal_split_draw_and_actual_usdc_payouts() {
    let f = V1::new().await;
    f.event("settle", 1_000_001, 500_000, None).await;
    assert_eq!(f.fund(&f.host, 500_000, "prize:settle").await, "500000");
    f.call("publish", json!({"event":"settle"})).await;
    for (id, a) in [("alice", &f.alice), ("bob", &f.bob), ("carol", &f.carol)] {
        f.register(id, "settle", a, a).await;
        assert_eq!(
            f.fund(a, 1_000_001, &format!("deposit:{id}")).await,
            "1000001"
        );
    }
    f.advance().await;
    for id in ["alice", "bob"] {
        f.call("check_in", json!({"registration":id})).await;
    }
    assert!(
        f.carol
            .call(f.escrow.id(), "check_in")
            .args_json(json!({"registration":"carol"}))
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.call("settle", json!({"event":"settle"})).await;
    let event = f.view("get_event", json!({"event":"settle"})).await;
    let winner = event["winner"].as_str().unwrap();
    assert!(winner == "alice" || winner == "bob");
    assert!(
        f.view("get_claim", json!({"claim":"carol"}))
            .await
            .is_null()
    );
    assert!(
        f.host
            .call(f.escrow.id(), "settle")
            .args_json(json!({"event":"settle"}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    for id in ["alice", "bob"] {
        f.call("withdraw", json!({"claim":id})).await;
    }
    assert_eq!(
        f.balance(&f.alice).await,
        100_000_000 + 500_001 + if winner == "alice" { 500_000 } else { 0 }
    );
    assert_eq!(
        f.balance(&f.bob).await,
        100_000_000 + 500_000 + if winner == "bob" { 500_000 } else { 0 }
    );
    assert_eq!(f.balance(&f.carol).await, 98_999_999);
    assert_eq!(f.balance(&f.host).await, 99_500_000);
    assert_eq!(f.view("accounting", json!({})).await["held"], "0");
    let storage = f.escrow.view_account().await.unwrap().storage_usage;
    let code = std::fs::metadata("/cache/target/wasm32-unknown-unknown/release/showup_v1.wasm")
        .unwrap()
        .len();
    println!(
        "V1 three-attendee settlement state above code: {} bytes",
        storage - code
    );
    assert!(
        storage <= code + 10_000,
        "Demo exceeds quoted state allowance"
    );
}

#[tokio::test]
async fn v1_no_attendees_refunds_every_principal_and_prize() {
    let f = V1::new().await;
    f.event("empty", 1_000_000, 500_000, None).await;
    f.fund(&f.host, 500_000, "prize:empty").await;
    f.call("publish", json!({"event":"empty"})).await;
    f.register("alice", "empty", &f.alice, &f.alice).await;
    f.fund(&f.alice, 1_000_000, "deposit:alice").await;
    f.advance().await;
    f.call("settle", json!({"event":"empty"})).await;
    for id in ["alice", "prize:empty"] {
        f.call("withdraw", json!({"claim":id})).await;
    }
    assert_eq!(f.balance(&f.alice).await, 100_000_000);
    assert_eq!(f.balance(&f.host).await, 100_000_000);
    assert_eq!(f.view("accounting", json!({})).await["held"], "0");
}

#[tokio::test]
async fn v1_failed_token_transfer_preserves_claim_until_actual_delivery() {
    let f = V1::new().await;
    let receiver = f.worker.dev_create_account().await.unwrap();
    f.event("retry", 1_000_000, 0, None).await;
    f.call("publish", json!({"event":"retry"})).await;
    f.register("alice", "retry", &f.alice, &receiver).await;
    f.fund(&f.alice, 1_000_000, "deposit:alice").await;
    f.call("cancel", json!({"event":"retry"})).await;
    assert_eq!(f.call("withdraw", json!({"claim":"alice"})).await, false);
    assert_eq!(
        f.view("get_claim", json!({"claim":"alice"})).await["remaining"],
        "1000000"
    );
    f.token
        .call("register")
        .args_json(json!({"account":receiver.id()}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(f.call("withdraw", json!({"claim":"alice"})).await, true);
    assert_eq!(f.balance(&receiver).await, 1_000_000);
    assert_eq!(f.view("accounting", json!({})).await["held"], "0");
}

#[tokio::test]
async fn v1_nft_requests_match_independent_ethereum_images_for_winner_and_cancel() {
    let vectors: Value =
        serde_json::from_str(include_str!("../fixtures/v1-nft-transactions.json")).unwrap();
    for (index, event) in ["winner", "cancel"].iter().enumerate() {
        let f = V1::new().await;
        let vector = &vectors[index];
        f.event(event,1_000_000,0,Some(json!({"collection":format!("0x{}","11".repeat(20)),"token_id":"2829","contributor":format!("0x{}","33".repeat(20))}))).await;
        assert!(
            f.host
                .call(f.escrow.id(), "publish")
                .args_json(json!({"event":event}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        let key = bs58::encode(decode_hex(vector["publicKey"].as_str().unwrap())).into_string();
        f.mock(json!({"caller":f.escrow.id(),"path":format!("showup:v1:{event}"),"domain_id":0,"public_key":format!("secp256k1:{key}")})).await;
        f.call("derive_nft_custody", json!({"event":event})).await;
        let state = f.view("get_event", json!({"event":event})).await;
        assert_eq!(
            state["nft"]["custody"],
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
        if index == 0 {
            f.call("confirm_nft_custody", json!({"event":event})).await;
            f.call("publish", json!({"event":event})).await;
            f.register("nft-alice", event, &f.alice, &f.alice).await;
            f.fund(&f.alice, 1_000_000, "deposit:nft-alice").await;
            let early=f.host.call(f.escrow.id(),"release_nft").args_json(json!({"event":event,"nonce":0,"gas_limit":100000,"priority_fee":"100000000","max_fee":"200000000"})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap();
            assert!(early.is_failure());
            f.advance().await;
            f.call("check_in", json!({"registration":"nft-alice"}))
                .await;
            f.call("settle", json!({"event":event})).await;
        } else {
            f.call("cancel", json!({"event":event})).await;
            // A late observed NFT arrival after cancellation must remain returnable.
            f.call("confirm_nft_custody", json!({"event":event})).await;
        }
        let request = json!({"path":format!("showup:v1:{event}"),"domain_id":0,"payload_v2":{"Ecdsa":vector["payload"]}});
        f.mock(json!({"caller":f.escrow.id(),"request":request,"response":vector["response"],"failure":index==0}))
            .await;
        let args = json!({"event":event,"nonce":0,"gas_limit":100000,"priority_fee":"100000000","max_fee":"200000000"});
        assert!(
            f.bob
                .call(f.escrow.id(), "release_nft")
                .args_json(args.clone())
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        f.host
            .call(f.escrow.id(), "release_nft")
            .args_json(args.clone())
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let state = f.view("get_event", json!({"event":event})).await;
        if index == 0 {
            assert_eq!(state["nft"]["request"]["state"], "unresolved");
            assert!(
                f.bob
                    .call(f.escrow.id(), "reconcile_nft_signature")
                    .args_json(json!({"event":event,"response":vectors[1]["response"]}))
                    .transact()
                    .await
                    .unwrap()
                    .is_failure()
            );
            f.bob
                .call(f.escrow.id(), "reconcile_nft_signature")
                .args_json(json!({"event":event,"response":vector["response"]}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
        }
        let state = f.view("get_event", json!({"event":event})).await;
        let image = &state["nft"]["request"];
        assert_eq!(image["state"], "signed");
        assert_eq!(image["recipient"], vector["recipient"]);
        assert_eq!(image["payload"], vector["payload"]);
        let wire = STANDARD
            .decode(image["unsigned_transaction"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            wire,
            decode_hex(
                vector["unsigned"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("0x")
            )
        );
        assert_eq!(format!("{:x}", Keccak256::digest(&wire)), vector["payload"]);
        assert!(
            f.host
                .call(f.escrow.id(), "release_nft")
                .args_json(args)
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
    }
}

fn decode_hex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test]
async fn v1_routed_rejections_refund_bound_users_not_shared_sender() {
    let f = V1::new().await;
    for event in ["cancelled", "full", "mismatch", "duplicate", "late"] {
        f.call("create_event", json!({"terms":{"id":event,"title":"Recovery","start_ms":f.start,"end_ms":f.start+600_000,"capacity":1,"deposit":"1000000","prize":"0","sponsor":f.host.id(),"nft":null}})).await;
        f.call("publish", json!({"event":event})).await;
        f.register(event, event, &f.bob, &f.alice).await;
    }
    // Model a shared Intents sender with distinct immutable payout accounts.
    f.register("seat", "full", &f.bob, &f.carol).await;
    assert_eq!(f.fund(&f.bob, 1_000_000, "deposit:seat").await, "1000000");
    f.call("cancel", json!({"event":"cancelled"})).await;
    for id in ["cancelled", "full", "duplicate"] {
        assert_eq!(
            f.fund(&f.bob, 1_000_000, &format!("deposit:{id}")).await,
            "1000000"
        );
    }
    assert_eq!(
        f.fund(&f.bob, 1_000_000, "deposit:duplicate").await,
        "1000000"
    );
    for amount in [500_000, 1_500_000] {
        assert_eq!(
            f.fund(&f.bob, amount, "deposit:mismatch").await,
            amount.to_string()
        );
    }
    // A different sender or unknown reference cannot credit another user's claim.
    assert_eq!(f.fund(&f.carol, 1_000_000, "deposit:mismatch").await, "0");
    assert_eq!(f.fund(&f.bob, 1_000_000, "deposit:unknown").await, "0");
    f.advance().await;
    assert_eq!(f.fund(&f.bob, 1_000_000, "deposit:late").await, "1000000");
    for event in ["cancelled", "full", "mismatch", "duplicate", "late"] {
        let registration = f
            .view("get_registration", json!({"registration":event}))
            .await;
        assert_eq!(registration["funded"], event == "duplicate");
        let claim = format!("recovery:{event}");
        let before = f.view("get_claim", json!({"claim":claim})).await;
        assert_eq!(before["recipient"], f.alice.id().as_str());
        assert_eq!(
            before["remaining"],
            if event == "mismatch" {
                "2000000"
            } else {
                "1000000"
            }
        );
        // A third party relays payment; the stored recipient is the only destination.
        f.call("withdraw", json!({"claim":claim})).await;
        if event != "cancelled" {
            f.call("cancel", json!({"event":event})).await;
        }
    }
    for claim in ["seat", "duplicate"] {
        f.call("withdraw", json!({"claim":claim})).await;
    }
    assert_eq!(f.balance(&f.bob).await, 92_000_000);
    assert_eq!(f.balance(&f.alice).await, 107_000_000);
    assert_eq!(f.balance(&f.carol).await, 101_000_000);
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"8000000","paid":"8000000","held":"0"})
    );
}

#[tokio::test]
async fn v1_recovery_credit_during_withdraw_preserves_both_payments() {
    let f = V1::new().await;
    let receiver = f.worker.dev_create_account().await.unwrap();
    f.event("interleave", 1_000_000, 0, None).await;
    f.call("publish", json!({"event":"interleave"})).await;
    f.register("interleave", "interleave", &f.bob, &receiver)
        .await;
    f.call("cancel", json!({"event":"interleave"})).await;
    f.fund(&f.bob, 1_000_000, "deposit:interleave").await;
    // Fail once while unregistered. The second credit arrives between withdrawal
    // initiation and callback, in the same NEAR action batch.
    for success in [false, true] {
        if success {
            f.token
                .call("register")
                .args_json(json!({"account":receiver.id()}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
        }
        f.token.call("transfer_during_withdraw").args_json(json!({"sender":f.bob.id(),"receiver":f.escrow.id(),"amount":"1000000","msg":"deposit:interleave","claim":"recovery:interleave"})).max_gas().transact().await.unwrap().into_result().unwrap();
        let state = f
            .view("get_claim", json!({"claim":"recovery:interleave"}))
            .await;
        assert_eq!(
            state["remaining"],
            if success { "1000000" } else { "2000000" }
        );
        assert_eq!(state["in_flight"], "0");
        assert_eq!(state["pending"], false);
    }
    f.call("withdraw", json!({"claim":"recovery:interleave"}))
        .await;
    assert_eq!(f.balance(&receiver).await, 3_000_000);
    assert_eq!(f.balance(&f.bob).await, 97_000_000);
    assert_eq!(
        f.view("accounting", json!({})).await,
        json!({"received":"3000000","paid":"3000000","held":"0"})
    );
}

#[tokio::test]
async fn v1_initialization_rejects_outsiders_and_atomic_deployment_works() {
    let f = V1::new().await;
    let wasm =
        std::fs::read("/cache/target/wasm32-unknown-unknown/release/showup_v1.wasm").unwrap();
    let uninitialized = f.worker.dev_deploy(&wasm).await.unwrap();
    let args = json!({"owner":f.host.id(),"token":f.token.id(),"signer":f.token.id()});
    let attempt = f
        .bob
        .call(uninitialized.id(), "new")
        .args_json(args.clone())
        .transact()
        .await
        .unwrap();
    assert!(format!("{:?}", attempt.failures()).contains("Self initialization only"));
    uninitialized
        .call("new")
        .args_json(args.clone())
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let fresh = f.worker.dev_create_account().await.unwrap();
    fresh
        .batch(fresh.id())
        .deploy(&wasm)
        .call(Function::new("new").args_json(args.clone()))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert!(
        f.bob
            .call(fresh.id(), "new")
            .args_json(args)
            .transact()
            .await
            .unwrap()
            .is_failure()
    );
    f.host.call(fresh.id(), "create_event").args_json(json!({"terms":{"id":"atomic","title":"Atomic","start_ms":f.start,"end_ms":f.start+600_000,"capacity":1,"deposit":"1000000","prize":"0","sponsor":f.host.id(),"nft":null}})).transact().await.unwrap().into_result().unwrap();
}

#[tokio::test]
async fn v1_nft_retry_is_bounded_authorized_and_keeps_original_transaction() {
    let vectors: Value =
        serde_json::from_str(include_str!("../fixtures/v1-nft-transactions.json")).unwrap();
    let vector = &vectors[1];
    for exhaust in [false, true] {
        let f = V1::new().await;
        f.event("cancel", 1_000_000, 0, Some(json!({"collection":format!("0x{}","11".repeat(20)),"token_id":"2829","contributor":format!("0x{}","33".repeat(20))}))).await;
        let key = bs58::encode(decode_hex(vector["publicKey"].as_str().unwrap())).into_string();
        f.mock(json!({"caller":f.escrow.id(),"path":"showup:v1:cancel","domain_id":0,"public_key":format!("secp256k1:{key}")})).await;
        f.call("derive_nft_custody", json!({"event":"cancel"}))
            .await;
        f.call("cancel", json!({"event":"cancel"})).await;
        f.call("confirm_nft_custody", json!({"event":"cancel"}))
            .await;
        let request = json!({"path":"showup:v1:cancel","domain_id":0,"payload_v2":{"Ecdsa":vector["payload"]}});
        f.mock(json!({"caller":f.escrow.id(),"request":request,"failure":true}))
            .await;
        let args = json!({"event":"cancel","nonce":0,"gas_limit":100000,"priority_fee":"100000000","max_fee":"200000000"});
        f.host
            .call(f.escrow.id(), "release_nft")
            .args_json(args.clone())
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let original =
            f.view("get_event", json!({"event":"cancel"})).await["nft"]["request"].clone();
        assert_eq!(original["state"], "unresolved");
        assert!(original["signature"].is_null());
        assert!(
            f.bob
                .call(f.escrow.id(), "retry_nft_signature")
                .args_json(json!({"event":"cancel"}))
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        assert!(
            f.host
                .call(f.escrow.id(), "retry_nft_signature")
                .args_json(json!({"event":"cancel"}))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        assert!(
            f.bob
                .call(f.escrow.id(), "on_nft_signature")
                .args_json(json!({"event":"cancel","attempt":1}))
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        let mut changed = args.clone();
        changed["nonce"] = json!(1);
        assert!(
            f.host
                .call(f.escrow.id(), "release_nft")
                .args_json(changed)
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        for attempt in [2, 3] {
            // A malformed response must also remain retryable; only the final valid
            // signature may resolve the immutable transaction.
            let response = if attempt == 3 {
                vector["response"].clone()
            } else {
                json!({})
            };
            f.mock(json!({"caller":f.escrow.id(),"request":request,"failure":exhaust,"response":response})).await;
            f.host
                .call(f.escrow.id(), "retry_nft_signature")
                .args_json(json!({"event":"cancel"}))
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
            let current =
                f.view("get_event", json!({"event":"cancel"})).await["nft"]["request"].clone();
            assert_eq!(current["attempt"], attempt);
            for field in ["recipient", "payload", "unsigned_transaction"] {
                assert_eq!(current[field], original[field]);
            }
            assert_eq!(
                current["state"],
                if attempt == 3 && !exhaust {
                    "signed"
                } else {
                    "unresolved"
                }
            );
        }
        assert!(
            f.host
                .call(f.escrow.id(), "retry_nft_signature")
                .args_json(json!({"event":"cancel"}))
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        if exhaust {
            f.call(
                "reconcile_nft_signature",
                json!({"event":"cancel","response":vector["response"]}),
            )
            .await;
        }
        let final_state = f.view("get_event", json!({"event":"cancel"})).await;
        assert_eq!(final_state["nft"]["request"]["state"], "signed");
        assert_eq!(final_state["nft"]["request"]["payload"], vector["payload"]);
    }
}

#[tokio::test]
async fn v1_nft_fee_ceiling_is_bounded_and_preserves_the_fixed_recipient() {
    let vectors: Value =
        serde_json::from_str(include_str!("../fixtures/v1-nft-transactions.json")).unwrap();
    let vector = &vectors[1];
    let f = V1::new().await;
    f.event("fee-bound",1_000_000,0,Some(json!({"collection":format!("0x{}","11".repeat(20)),"token_id":"2829","contributor":format!("0x{}","33".repeat(20))}))).await;
    let key = bs58::encode(decode_hex(vector["publicKey"].as_str().unwrap())).into_string();
    f.mock(json!({"caller":f.escrow.id(),"path":"showup:v1:fee-bound","domain_id":0,"public_key":format!("secp256k1:{key}")})).await;
    f.call("derive_nft_custody", json!({"event":"fee-bound"}))
        .await;
    f.call("cancel", json!({"event":"fee-bound"})).await;
    f.call("confirm_nft_custody", json!({"event":"fee-bound"}))
        .await;
    for (gas, fee) in [(100000, 20000000001u64), (250001, 1)] {
        let rejected=f.host.call(f.escrow.id(),"release_nft").args_json(json!({"event":"fee-bound","nonce":0,"gas_limit":gas,"priority_fee":"1","max_fee":fee.to_string()})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap();
        assert!(rejected.is_failure());
        assert!(
            f.view("get_event", json!({"event":"fee-bound"})).await["nft"]["request"].is_null()
        );
    }
    // The signer can fail without changing the accepted, fixed transaction.
    f.mock(json!({"caller":f.escrow.id(),"request":{},"failure":true}))
        .await;
    let accepted=f.host.call(f.escrow.id(),"release_nft").args_json(json!({"event":"fee-bound","nonce":0,"gas_limit":100000,"priority_fee":"100000000","max_fee":"20000000000"})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap();
    assert!(
        accepted.is_success(),
        "Reviewed NFT fee ceiling must support real-network fees"
    );
    let event = f.view("get_event", json!({"event":"fee-bound"})).await;
    assert_eq!(
        event["nft"]["request"]["recipient"],
        format!("0x{}", "33".repeat(20))
    );
    assert_eq!(event["nft"]["request"]["attempt"], 1);
    assert_eq!(
        event["nft"]["custody"],
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
}
