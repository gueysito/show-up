mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use near_crypto::{KeyType, SecretKey};
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn fixture(network: &str) -> (Fixture, SecretKey, Value) {
    let mut f = Fixture::new(1, "online", 0).await;
    // Newly generated disposable key remains only in this test process's memory.
    let key = SecretKey::from_random(if network == "solana" {
        KeyType::ED25519
    } else {
        KeyType::SECP256K1
    });
    let public = key.public_key();
    let source = if network == "solana" {
        bs58::encode(public.key_data()).into_string()
    } else {
        format!("0x{}", hex(&Keccak256::digest(public.key_data())[12..]))
    };
    let address = |n: u8| {
        if network == "solana" {
            bs58::encode([n; 32]).into_string()
        } else {
            format!("0x{}", hex(&[n; 20]))
        }
    };
    let mut terms = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
    f.event = id(200);
    terms["event"] = json!(f.event);
    terms["custody_proof_policy"] = json!({"network":network,"source":source,"collection":address(1),
        "asset":if network=="solana" {address(2)} else {format!("0x{}", id(2))}, "beneficiary":address(3),"contributor":address(4),
        "fee_cap":if network=="solana" {"20000"} else {"300000000000000"},
        "signer":{"provider":f.token.id(),"domain_id":if network=="solana" {1} else {0}}});
    terms["observer_policy"] = json!({"key":STANDARD.encode(f.observer.verifying_key().to_bytes()),
        "profile_hash":id(9400),"sources":["fixture-one","fixture-two"],"operators":["fixture-operator-one","fixture-operator-two"]});
    f.rules_hash = f.rules_commitment(&terms);
    terms["rules_hash"] = json!(f.rules_hash);
    f.escrow
        .call("create_event")
        .args_json(json!({"terms":terms}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let descriptor = json!({"deployment":f.escrow.id(),"environment":"engineering","network":network,
        "event":f.event,"collection":terms["custody_proof_policy"]["collection"],"asset":terms["custody_proof_policy"]["asset"]});
    let path = format!(
        "showup.v1/engineering/{network}/{}",
        hex(&Sha256::digest(descriptor.to_string()))
    );
    let config = json!({"caller":f.escrow.id(),"path":path,"domain_id":if network=="solana" {1} else {0},
        "public_key":public.to_string(),"request":null,"response":null,"failure":false});
    (f, key, config)
}
async fn configure(f: &Fixture, config: &Value) {
    f.token
        .call("configure_signer")
        .args_json(json!({"configuration":config}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
}
async fn derive(f: &Fixture) -> Value {
    f.bob
        .call(f.escrow.id(), "derive_custody_key")
        .args_json(json!({"event":f.event}))
        .max_gas()
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap()
        .json()
        .unwrap()
}
async fn prepare(f: &Fixture, network: &str) -> (Value, Value) {
    let receipt = f.holding_observation().await;
    f.submit_observation(&receipt).await.into_result().unwrap();
    f.host
        .call(f.escrow.id(), "publish")
        .args_json(json!({"event":f.event}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
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
            json!({"blockhash":bs58::encode([9;32]).into_string(),
        "compute_units":100000,"estimated_fee":"5000","last_valid_block_height":"150"}),
        )
    } else {
        (
            "prepare_evm_custody",
            json!({"nonce":0,"gas_limit":100000,"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"500000000"}),
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
    (intent, image)
}
fn response(key: &SecretKey, image: &Value) -> Value {
    let payload = STANDARD.decode(image["payload"].as_str().unwrap()).unwrap();
    let signature = key.sign(&payload).to_string();
    let bytes = bs58::decode(signature.split_once(':').unwrap().1)
        .into_vec()
        .unwrap();
    if image["scheme"] == "Eddsa" {
        json!({"scheme":"Ed25519","signature":bytes})
    } else {
        json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("{:02x}{}",2+bytes[64],hex(&bytes[..32]))},
        "s":{"scalar":hex(&bytes[32..64])},"recovery_id":bytes[64]})
    }
}
fn request(config: &mut Value, image: &Value, reply: &Value) {
    let payload = hex(&STANDARD.decode(image["payload"].as_str().unwrap()).unwrap());
    config["request"] = json!({"path":image["path"],"domain_id":config["domain_id"],
        "payload_v2":if image["scheme"]=="Eddsa" {json!({"Eddsa":payload})} else {json!({"Ecdsa":payload})}});
    config["response"] = reply.clone();
}
fn image_hash(image: &Value) -> String {
    hex(&Sha256::digest(
        STANDARD
            .decode(image["unsigned"].as_str().unwrap())
            .unwrap(),
    ))
}
async fn trace(f: &Fixture) -> Value {
    f.token
        .view("get_signer_trace")
        .args_json(json!({}))
        .await
        .unwrap()
        .json()
        .unwrap()
}

#[tokio::test]
async fn custody_provider_abi_binds_derived_source_and_sends_each_typed_image_only_once() {
    let mut vectors = vec![];
    for network in ["base", "ethereum", "solana"] {
        let (f, key, mut config) = fixture(network).await;
        let holding = f.holding_observation().await;
        f.submit_observation(&holding).await.into_result().unwrap();
        assert!(
            f.host
                .call(f.escrow.id(), "publish")
                .args_json(json!({"event":f.event}))
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Holding is insufficient without derived source control"
        );
        let mut wrong = config.clone();
        wrong["public_key"] = json!(
            SecretKey::from_random(if network == "solana" {
                KeyType::ED25519
            } else {
                KeyType::SECP256K1
            })
            .public_key()
            .to_string()
        );
        configure(&f, &wrong).await;
        assert_eq!(derive(&f).await["state"], "unresolved");
        configure(&f, &config).await;
        let binding = derive(&f).await;
        assert_eq!(binding["state"], "verified");
        assert_eq!(binding["path"], config["path"]);
        assert!(
            f.bob
                .call(f.escrow.id(), "derive_custody_key")
                .args_json(json!({"event":f.event}))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure()
        );
        let (intent, image) = prepare(&f, network).await;
        let reply = response(&key, &image);
        request(&mut config, &image, &reply);
        configure(&f, &config).await;
        assert!(
            f.bob
                .call(f.escrow.id(), "request_custody_signature")
                .args_json(json!({"event":f.event}))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Missing native signing deposit rejected"
        );
        let a = f
            .alice
            .call(f.escrow.id(), "request_custody_signature")
            .args_json(json!({"event":f.event}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact();
        let b = f
            .bob
            .call(f.escrow.id(), "request_custody_signature")
            .args_json(json!({"event":f.event}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact();
        let (a, b) = tokio::join!(a, b);
        let a = a.unwrap();
        let b = b.unwrap();
        assert_ne!(
            a.is_success(),
            b.is_success(),
            "A race must submit exactly one provider request"
        );
        let stored = f
            .view(
                "get_custody_signing_request",
                json!({"event":f.event,"image_hash":image_hash(&image)}),
            )
            .await;
        assert_eq!(stored["state"], "signed");
        assert_eq!(stored["payload"], image["payload"]);
        let observed = trace(&f).await;
        assert_eq!(observed["calls"], 1);
        assert_eq!(observed["last"]["request"], config["request"]);
        assert_eq!(observed["last"]["caller"], json!(f.escrow.id()));
        assert!(
            f.bob
                .call(f.escrow.id(), "on_custody_signature")
                .args_json(json!({"event":f.event,"image_hash":image_hash(&image)}))
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Foreign callback rejected"
        );
        assert!(
            f.escrow
                .call("on_custody_signature")
                .args_json(json!({"event":f.event,"image_hash":image_hash(&image)}))
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Self call without a promise result rejected"
        );
        let repeated: Value = f
            .bob
            .call(f.escrow.id(), "reconcile_custody_signature")
            .args_json(json!({"event":f.event,"image_hash":image_hash(&image),"response":reply}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(repeated, stored);
        assert_eq!(trace(&f).await["calls"], 1);
        let mut delivery = f.holding_observation().await;
        delivery["block_height"] = json!("200");
        delivery["block_hash"] = json!(if network == "solana" {
            bs58::encode([12; 32]).into_string()
        } else {
            format!("0x{}", id(200))
        });
        delivery["operation"] = intent["operation"].clone();
        delivery["owner"] = intent["recipient"].clone();
        delivery["intent_hash"] = image["intent_hash"].clone();
        delivery["image_hash"] = json!(image_hash(&image));
        delivery["transaction_block_height"] = json!("50");
        delivery["transaction_block_hash"] = delivery["block_hash"].clone();
        delivery["transaction_ms"] = json!(delivery["block_ms"].as_u64().unwrap() - 1);
        delivery["transaction"] = json!(if network == "solana" {
            bs58::encode([8; 64]).into_string()
        } else {
            format!("0x{}", id(800))
        });
        assert!(
            f.submit_observation(&delivery).await.is_failure(),
            "A signed observer cannot substitute an unrelated transaction"
        );
        delivery["transaction"] = stored["transaction"].clone();
        assert_eq!(
            f.submit_observation(&delivery)
                .await
                .into_result()
                .unwrap()
                .json::<Value>()
                .unwrap()["delivered"],
            true
        );
        vectors.push(json!({"network":network,"intent":intent,"image":image,"binding":binding,"request":stored,"provider_trace":observed,"response":reply}));
    }
    std::fs::write(
        "/cache/custody-signatures-public.json",
        serde_json::to_vec_pretty(&vectors).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn recovery_requires_the_exact_transaction_from_a_reconciled_original_signature() {
    for network in ["base", "ethereum", "solana"] {
        let (f, key, mut config) = fixture(network).await;
        configure(&f, &config).await;
        derive(&f).await;
        let (intent, image) = prepare(&f, network).await;
        request(&mut config, &image, &response(&key, &image));
        configure(&f, &config).await;
        let signed: Value = f
            .bob
            .call(f.escrow.id(), "request_custody_signature")
            .args_json(json!({"event":f.event}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        let envelope = if network == "solana" {
            json!({"blockhash":bs58::encode([10;32]).into_string(),"compute_units":100000,"estimated_fee":"5000","last_valid_block_height":"200"})
        } else {
            json!({"nonce":1,"gas_limit":100000,"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"500000000"})
        };
        let now = f.timestamp().await;
        let block = if network == "solana" {
            bs58::encode([11; 32]).into_string()
        } else {
            format!("0x{}", id(100))
        };
        let wrong = if network == "solana" {
            bs58::encode([8; 64]).into_string()
        } else {
            format!("0x{}", id(800))
        };
        let mut receipt = json!({"format":"showup.custody.recovery.v1","domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),
            "manifest":intent["manifest"],"event":f.event,"rules_hash":f.rules_hash,"network":network,
            "chain_id":if network=="solana" {"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"}else if network=="base" {"84532"}else{"11155111"},
            "profile_hash":id(9400),"sources":["fixture-one","fixture-two"],"intent_hash":image["intent_hash"],
            "previous_image_hash":image_hash(&image),"new_envelope_hash":hex(&Sha256::digest(envelope.to_string())),
            "reason":if network=="solana" {"solana_failed"}else{"failed_nonce"},"owner":intent["source"],
            "account_nonce":if network=="solana" {Value::Null}else{json!("1")},"failed_image_hash":image_hash(&image),
            "transaction":wrong,"transaction_failed":true,"signature_status_absent":false,
            "blockhash_valid":if network=="solana" {json!(true)}else{Value::Null},"new_blockhash_valid":if network=="solana" {json!(true)}else{Value::Null},
            "transaction_block_height":"50","transaction_block_hash":block,"reported_fee":"5000","block_height":"1000",
            "block_hash":block,"block_ms":now-1000,"finalized_block_height":if network=="solana" {json!("100")}else{Value::Null},
            "observed_ms":now,"expires_ms":now+60000,"nonce":id(900)});
        let method = if network == "solana" {
            "recover_solana_custody"
        } else {
            "recover_evm_custody"
        };
        assert!(f.bob.call(f.escrow.id(),method).args_json(json!({"receipt":receipt,"proof":proof(&f.observer,&receipt),"envelope":envelope})).max_gas().transact().await.unwrap().is_failure());
        receipt["transaction"] = signed["transaction"].clone();
        let rebuilt: Value = f
            .bob
            .call(f.escrow.id(), method)
            .args_json(
                json!({"receipt":receipt,"proof":proof(&f.observer,&receipt),"envelope":envelope}),
            )
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(rebuilt["generation"], 2);
        assert_eq!(rebuilt["intent_hash"], image["intent_hash"]);
        assert_eq!(
            trace(&f).await["calls"],
            1,
            "A recovery witness builds an image without submitting another signature request"
        );
    }
}

#[tokio::test]
async fn uncertain_provider_reply_recovers_only_the_original_valid_signature_without_resubmission()
{
    for network in ["base", "ethereum", "solana"] {
        let (f, key, mut config) = fixture(network).await;
        configure(&f, &config).await;
        derive(&f).await;
        let (_, image) = prepare(&f, network).await;
        let reply = response(&key, &image);
        let invalid = if network == "base" {
            json!("x".repeat(3000))
        } else {
            json!({"wrong":"invalid signature response"})
        };
        request(&mut config, &image, &invalid);
        config["failure"] = json!(network == "solana");
        configure(&f, &config).await;
        let stored: Value = f
            .bob
            .call(f.escrow.id(), "request_custody_signature")
            .args_json(json!({"event":f.event}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(stored["state"], "unresolved");
        let calls = if network == "solana" { 0 } else { 1 }; // A provider panic rolls back its own trace.
        assert_eq!(trace(&f).await["calls"], calls);
        config["failure"] = json!(false);
        config["response"] = reply.clone();
        configure(&f, &config).await;
        assert!(
            f.alice
                .call(f.escrow.id(), "request_custody_signature")
                .args_json(json!({"event":f.event}))
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Failure cannot authorize resubmission"
        );
        let wrongkey = SecretKey::from_random(if network == "solana" {
            KeyType::ED25519
        } else {
            KeyType::SECP256K1
        });
        let mut changed = image.clone();
        changed["payload"] = json!(STANDARD.encode(if network == "solana" {
            vec![1; 300]
        } else {
            vec![1; 32]
        }));
        let mut extra = reply.clone();
        extra["unknown"] = json!(true);
        for invalid in [
            response(&wrongkey, &image),
            response(&key, &changed),
            extra,
            json!({}),
            json!({"scheme":"Ed25519","signature":[1,2,3]}),
        ] {
            assert!(
                f.alice
                    .call(f.escrow.id(), "reconcile_custody_signature")
                    .args_json(
                        json!({"event":f.event,"image_hash":image_hash(&image),"response":invalid})
                    )
                    .max_gas()
                    .transact()
                    .await
                    .unwrap()
                    .is_failure(),
                "Mutated response must not reconcile"
            );
        }
        assert!(
            f.bob
                .call(f.escrow.id(), "reconcile_custody_signature")
                .args_json(
                    json!({"event":id(201),"image_hash":image_hash(&image),"response":reply})
                )
                .transact()
                .await
                .unwrap()
                .is_failure(),
            "Cross-event recovery rejected"
        );
        let final_state: Value = f
            .alice
            .call(f.escrow.id(), "reconcile_custody_signature")
            .args_json(json!({"event":f.event,"image_hash":image_hash(&image),"response":reply}))
            .max_gas()
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(final_state["state"], "signed");
        assert_eq!(trace(&f).await["calls"], calls);
        assert_eq!(
            f.view("get_custody_image", json!({"event":f.event})).await,
            image
        );
    }
}
