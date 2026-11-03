#![allow(dead_code)] // Shared helpers are used by different integration-test binaries.
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;

pub struct Fixture {
    pub worker: Worker<Sandbox>,
    pub escrow: Contract,
    pub token: Contract,
    pub host: Account,
    pub alice: Account,
    pub bob: Account,
    pub credential: SigningKey,
    pub evidence: SigningKey,
    pub draw: SigningKey,
    pub observer: SigningKey,
    pub start: u64,
    pub end: u64,
    pub event: String,
    pub rules_hash: String,
    _node: near_sandbox::Sandbox,
}

pub async fn start_node() -> (Worker<Sandbox>, near_sandbox::Sandbox) {
    let config = near_sandbox::SandboxConfig {
        // Timing tests do not test epoch transitions. Keep long jumps inside an
        // epoch rather than producing boundary blocks for each 60-block default.
        additional_genesis: Some(json!({"epoch_length":1_000_000})),
        additional_accounts: vec![near_sandbox::GenesisAccount::generate_with_name(
            "registrar".parse().unwrap(),
        )],
        ..Default::default()
    };
    let node = near_sandbox::Sandbox::start_sandbox_with_config_and_version(config, "2.13.4")
        .await
        .unwrap();
    let worker = near_workspaces::sandbox()
        .rpc_addr(&node.rpc_addr)
        .validator_key(near_workspaces::network::ValidatorKey::HomeDir(
            node.home_dir.path().to_path_buf(),
        ))
        .await
        .unwrap();
    eprintln!("Local sandbox ready with long test epochs; outbound networking disabled");
    (worker, node)
}

pub fn id(number: u64) -> String {
    format!("{number:064x}")
}
fn fresh_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .expect("OS randomness unavailable")
        .read_exact(&mut bytes)
        .expect("OS randomness incomplete");
    SigningKey::from_bytes(&bytes)
}
pub fn proof(key: &SigningKey, value: &Value) -> String {
    STANDARD.encode(key.sign(value.to_string().as_bytes()).to_bytes())
}

impl Fixture {
    pub fn rules_commitment(&self, terms: &Value) -> String {
        let mut terms = terms.clone();
        terms.as_object_mut().unwrap().remove("rules_hash");
        let context = json!({"format":"showup.event.rules.v1","authorization_domain":"showup.sandbox.authorization.v1",
            "deployment":self.escrow.id(),"manifest":"local-v1","settlement_token":self.token.id(),"terms":terms});
        format!("{:x}", Sha256::digest(context.to_string()))
    }
    pub async fn close_for_draw(&self) {
        let auth = self.authorization(110, self.alice.id().as_str()).await;
        self.fund(&self.alice, &auth, 5_000_000).await;
        self.advance(self.start).await;
        let receipt = json!({"domain":"showup.sandbox.authorization.v1","deployment":self.escrow.id(),
            "manifest":"local-v1","event":self.event,"rules_hash":self.rules_hash,"registration":auth["registration"],
            "participant":auth["participant"],"proof_class":"live_code","received_ms":self.start,
            "nonce":id(8100),"expires_ms":self.end-600_000});
        self.alice
            .call(self.escrow.id(), "accept_attendance")
            .args_json(json!({"receipt":receipt,"proof":proof(&self.evidence,&receipt)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        self.advance(self.end - 600_000 + 1).await;
        self.host
            .call(self.escrow.id(), "record_end")
            .args_json(json!({"event":self.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let event = self.view("get_event", json!({"event":self.event})).await;
        let checkpoint = json!({"domain":"showup.sandbox.authorization.v1","deployment":self.escrow.id(),
            "manifest":"local-v1","event":self.event,"rules_hash":self.rules_hash,"ledger_version":event["ledger_version"],
            "complete_through_ms":self.end-900_000,"expires_ms":self.end+2_100_000});
        self.bob
            .call(self.escrow.id(), "close")
            .args_json(json!({"checkpoint":checkpoint,"proof":proof(&self.evidence,&checkpoint)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }
    pub async fn verified_draw(&self) {
        self.escrow
            .call("freeze_draw_proof")
            .args_json(json!({"event":self.event,"snapshot_hash":id(9200)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let binding: Value = self
            .escrow
            .call("bind_draw_proof")
            .args_json(json!({"event":self.event,"request_id":"original-42"}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        let alpha = binding["alpha"].as_str().unwrap();
        let signature = self.draw.sign(alpha.as_bytes()).to_bytes();
        self.bob.call(self.escrow.id(),"accept_draw_proof").args_json(json!({"event":self.event,"alpha":alpha,
            "signature":STANDARD.encode(signature),"output":format!("{:x}",Sha256::digest(signature))}))
            .transact().await.unwrap().into_result().unwrap();
    }
    pub async fn new(capacity: u32, mode: &str, budget: u128) -> Self {
        Self::with_custody(capacity, mode, budget, None).await
    }
    pub async fn with_custody(
        capacity: u32,
        mode: &str,
        budget: u128,
        custody: Option<Value>,
    ) -> Self {
        Self::build(capacity, mode, budget, custody, false, true, None).await
    }
    pub async fn with_unobserved_custody(custody: Value) -> Self {
        Self::build(1, "online", 0, Some(custody), false, false, None).await
    }
    pub async fn with_native() -> Self {
        Self::build(1, "online", 20_000_000, None, true, false, None).await
    }
    pub async fn with_financial_consent() -> Self {
        Self::build(
            1,
            "online",
            0,
            None,
            false,
            true,
            Some("https://localhost:3443"),
        )
        .await
    }
    async fn build(
        capacity: u32,
        mode: &str,
        budget: u128,
        custody: Option<Value>,
        native: bool,
        observed: bool,
        financial_origin: Option<&str>,
    ) -> Self {
        let (worker, node) = start_node().await;
        let wasm = "/cache/target/wasm32-unknown-unknown/release";
        let escrow = worker
            .dev_deploy(&std::fs::read(format!("{wasm}/showup_escrow.wasm")).unwrap())
            .await
            .unwrap();
        let token = worker
            .dev_deploy(&std::fs::read(format!("{wasm}/showup_test_token.wasm")).unwrap())
            .await
            .unwrap();
        let host = worker.dev_create_account().await.unwrap();
        let alice = worker.dev_create_account().await.unwrap();
        let bob = worker.dev_create_account().await.unwrap();
        let credential = fresh_key();
        let evidence = fresh_key();
        let draw = fresh_key();
        let observer = fresh_key();
        token
            .call("new")
            .args_json(json!({}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        escrow.call("new").args_json(json!({"token":token.id(), "domain":"showup.sandbox.authorization.v1",
            "manifest":"local-v1", "credential_key":STANDARD.encode(credential.verifying_key().to_bytes()),
            "evidence_key":STANDARD.encode(evidence.verifying_key().to_bytes())}))
            .transact().await.unwrap().into_result().unwrap();
        for account in [escrow.id(), host.id(), alice.id(), bob.id()] {
            token
                .call("register")
                .args_json(json!({"account":account}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
        }
        for account in [host.id(), alice.id(), bob.id()] {
            token
                .call("mint")
                .args_json(json!({"account":account,"amount":"100000000"}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
        }
        let start = worker.view_block().await.unwrap().timestamp() / 1_000_000 + 3_600_000;
        let end = start + 1_800_000;
        let event = id(1);
        let mut fixture = Self {
            worker,
            escrow,
            token,
            host,
            alice,
            bob,
            credential,
            evidence,
            draw,
            observer,
            start,
            end,
            event,
            rules_hash: String::new(),
            _node: node,
        };
        let mut terms = json!({"event":fixture.event,"rules_hash":id(2),"host":fixture.host.id(),"mode":mode,
            "capacity":capacity,"principal":"5000000","sponsor_budget":budget.to_string(),
            "sponsor_return":fixture.destination(fixture.host.id().as_str()),
            "start_ms":start,"end_ms":end,"latest_quiz_close_ms":0,"excluded":[id(9990)],
            "draw_policy":{"provider":"outlayer.local","project":"showup.local/vrf-test",
                "version_hash":id(9300),"sender":fixture.escrow.id(),"key":STANDARD.encode(fixture.draw.verifying_key().to_bytes())},
            "observer_policy":if custody.is_some() {json!({"key":STANDARD.encode(fixture.observer.verifying_key().to_bytes()),
                "profile_hash":id(9400),"sources":["fixture-one","fixture-two"],"operators":["fixture-operator-one","fixture-operator-two"]})} else {Value::Null},
            "custody_proof_policy":custody,
            "native_nft":if native {json!({"token":fixture.token.id(),"token_id":"prize-1", "contributor":fixture.alice.id(),
                "fixture_beneficiary":fixture.bob.id()})} else {Value::Null}});
        if let Some(origin) = financial_origin {
            terms["wallet_consent_origin"] = json!(origin);
        }
        fixture.rules_hash = fixture.rules_commitment(&terms);
        terms["rules_hash"] = json!(fixture.rules_hash);
        fixture
            .escrow
            .call("create_event")
            .args_json(json!({"terms":terms}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        if budget > 0 {
            fixture
                .transfer(
                    &fixture.host,
                    budget,
                    json!({"kind":"sponsor","event":fixture.event}),
                )
                .await;
        }
        if !native && observed {
            if terms["custody_proof_policy"].is_object() {
                let receipt = fixture.holding_observation().await;
                fixture
                    .submit_observation(&receipt)
                    .await
                    .into_result()
                    .unwrap();
            }
            fixture
                .host
                .call(fixture.escrow.id(), "publish")
                .args_json(json!({"event":fixture.event}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap();
        }
        fixture
    }

    pub async fn holding_observation(&self) -> Value {
        let item = self.view("get_event", json!({"event":self.event})).await;
        let policy = &item["terms"]["custody_proof_policy"];
        let network = policy["network"].as_str().unwrap();
        let current = self.timestamp().await;
        json!({"format":"showup.asset.observation.v2","domain":"showup.sandbox.authorization.v1",
            "deployment":self.escrow.id(),"manifest":"showup-engineering-2026-11-02-v1",
            "event":self.event,"rules_hash":self.rules_hash,"network":network,
            "chain_id":match network {"base"=>"84532","ethereum"=>"11155111",_=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"},
            "profile_hash":id(9400),"sources":["fixture-one","fixture-two"],"collection":policy["collection"],
            "asset":policy["asset"],"custody":policy["source"],"owner":policy["source"],"operation":"holding",
            "intent_hash":null,"image_hash":null,"transaction":null,"block_height":"100",
            "transaction_block_height":null,"transaction_block_hash":null,"transaction_ms":null,
            "block_hash":if network == "solana" {bs58::encode([10u8;32]).into_string()} else {format!("0x{}",id(100))},
            "block_ms":current-1000,"observed_ms":current,"expires_ms":current+60_000,"finalized":true,"fee":"0"})
    }
    pub async fn submit_observation(
        &self,
        receipt: &Value,
    ) -> near_workspaces::result::ExecutionFinalResult {
        self.bob
            .call(self.escrow.id(), "observe_asset")
            .args_json(json!({"receipt":receipt,"proof":proof(&self.observer,receipt)}))
            .transact()
            .await
            .unwrap()
    }

    pub fn destination(&self, address: &str) -> Value {
        json!({"network":"near","asset":self.token.id(),"address":address})
    }
    pub async fn timestamp(&self) -> u64 {
        self.worker.view_block().await.unwrap().timestamp() / 1_000_000
    }
    pub async fn advance(&self, target: u64) {
        for _ in 0..5 {
            let current = self.timestamp().await;
            if current >= target {
                return;
            }
            self.worker
                // nearcore 2.13.4 sandbox_delta_time averages fast-mode 120/500ms.
                .fast_forward((target - current).div_ceil(310) + 2)
                .await
                .unwrap();
        }
        assert!(
            self.timestamp().await >= target,
            "Sandbox clock did not reach target"
        );
    }
    pub async fn authorization(&self, number: u64, address: &str) -> Value {
        let now = self.timestamp().await;
        json!({"domain":"showup.sandbox.authorization.v1","deployment":self.escrow.id(),
            "manifest":"local-v1","event":self.event,"rules_hash":self.rules_hash,"registration":id(number),
            "participant":id(number+1000),"wallet_tag":id(number+2000),"principal":"5000000",
            "source":self.destination(address),"refund":self.destination(address),"payout":self.destination(address),"fee_cap":"100000",
            "nonce":id(number+3000),"expires_ms":self.start,"reservation_ms":now+240_000})
    }
    pub async fn transfer(&self, actor: &Account, amount: u128, message: Value) -> Value {
        actor
            .call(self.token.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id":self.escrow.id(),
            "amount":amount.to_string(),"msg":message.to_string()}))
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
    pub async fn fund(&self, actor: &Account, auth: &Value, amount: u128) -> Value {
        self.transfer(
            actor,
            amount,
            json!({"kind":"commitment","authorization":auth,
            "proof":proof(&self.credential,auth)}),
        )
        .await
    }
    pub async fn view(&self, method: &str, args: Value) -> Value {
        self.escrow
            .view(method)
            .args_json(args)
            .await
            .unwrap()
            .json()
            .unwrap()
    }
    pub async fn liability(&self, registration: u64, kind: &str) -> Value {
        self.view(
            "get_liability",
            json!({"id":format!("{}:{kind}",id(registration))}),
        )
        .await
    }
    pub async fn balance(&self, account: &str) -> u128 {
        let value: String = self
            .token
            .view("ft_balance_of")
            .args_json(json!({"account_id":account}))
            .await
            .unwrap()
            .json()
            .unwrap();
        value.parse().unwrap()
    }
    pub async fn release(&self, auth: &Value) {
        let action = json!({"domain":"showup.sandbox.authorization.v1","deployment":self.escrow.id(),
            "manifest":"local-v1","event":self.event,"registration":auth["registration"],"participant":auth["participant"],
            "operation":"release","nonce":id(9000),"expires_ms":self.timestamp().await+240_000});
        self.bob
            .call(self.escrow.id(), "release")
            .args_json(json!({"action":action,"proof":proof(&self.credential,&action)}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }
}
