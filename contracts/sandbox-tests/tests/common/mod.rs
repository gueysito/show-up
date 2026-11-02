#![allow(dead_code)] // Shared helpers are used by different integration-test binaries.
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use serde_json::{Value, json};
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
    pub start: u64,
    pub end: u64,
    pub event: String,
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
    pub async fn new(capacity: u32, mode: &str, budget: u128) -> Self {
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
        let fixture = Self {
            worker,
            escrow,
            token,
            host,
            alice,
            bob,
            credential,
            evidence,
            draw,
            start,
            end,
            event,
            _node: node,
        };
        let terms = json!({"event":fixture.event,"rules_hash":id(2),"host":fixture.host.id(),"mode":mode,
            "capacity":capacity,"principal":"5000000","sponsor_budget":budget.to_string(),
            "sponsor_return":fixture.destination(fixture.host.id().as_str()),
            "start_ms":start,"end_ms":end,"latest_quiz_close_ms":0,"excluded":[id(9990)],
            "draw_policy":{"provider":"outlayer.local","project":"showup.local/vrf-test",
                "version_hash":id(9300),"sender":fixture.escrow.id(),"key":STANDARD.encode(fixture.draw.verifying_key().to_bytes())}});
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
        fixture
            .host
            .call(fixture.escrow.id(), "publish")
            .args_json(json!({"event":fixture.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        fixture
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
            "manifest":"local-v1","event":self.event,"rules_hash":id(2),"registration":id(number),
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
