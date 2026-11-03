mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use near_workspaces::Account;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn exchange(root: &Path, mode: &str, stage: &str, output: &Value) -> Value {
    let request = root.join(format!("{mode}.{stage}.request.json"));
    let temporary = request.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(output).unwrap()).unwrap();
    std::fs::rename(temporary, request).unwrap();
    let response = root.join(format!("{mode}.{stage}.response.json"));
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(bytes) = std::fs::read(&response) {
            assert!(
                bytes.len() <= 262_144,
                "Oversized application bridge response"
            );
            return serde_json::from_slice(&bytes).unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "Application bridge peer timed out"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
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

fn financial_signature(signer: &Account, input: &Value) -> Value {
    let digest = STANDARD.decode(input["digest"].as_str().unwrap()).unwrap();
    assert_eq!(digest.len(), 32);
    // Only the generated sandbox account's in-memory key signs this bridge.
    // No private key is exported and no operator file or public network is used.
    let key: near_crypto::SecretKey = signer.secret_key().to_string().parse().unwrap();
    let near_crypto::Signature::ED25519(signature) = key.sign(&digest) else {
        panic!("Ed25519 sandbox signer required")
    };
    json!({"accountId":signer.id(),"publicKey":key.public_key().to_string(),"signature":STANDARD.encode(signature.to_bytes())})
}

#[tokio::test]
#[ignore = "Requires the Node/PostgreSQL peer; run npm run contracts:app-bridge"]
async fn application_attendance_round_trip() {
    let id = std::env::var("SHOWUP_APP_BRIDGE").expect("Explicit app bridge required");
    assert!(
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    let root = PathBuf::from(format!("/cache/app-bridge/{id}"));
    assert!(root.is_dir());
    for mode in ["online", "physical"] {
        let mut f = Fixture::with_financial_consent().await;
        let setup = exchange(&root, mode, "setup", &json!({"mode":mode}));
        let mut terms = f.view("get_event", json!({"event":f.event})).await["terms"].clone();
        f.event = setup["event"].as_str().unwrap().to_owned();
        assert!(f.event.len() == 64 && f.event.bytes().all(|b| b.is_ascii_hexdigit()));
        f.start = f.timestamp().await + 120_000;
        f.end = f.start + 1_800_000;
        terms["event"] = json!(f.event);
        terms["mode"] = json!(mode);
        terms["start_ms"] = json!(f.start);
        terms["end_ms"] = json!(f.end);
        terms["excluded"] = setup["excluded"].clone();
        terms["wallet_consent_origin"] = json!("https://localhost:3444");
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
        f.host
            .call(f.escrow.id(), "publish")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let issued = f.timestamp().await;
        let prepared = exchange(
            &root,
            mode,
            "consent",
            &json!({"terms":terms,"deployment":f.escrow.id(),"token":f.token.id(),
            "wallet":f.alice.id(),"issuedAt":issued,"publishedAt":issued,"evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes())}),
        );
        let wallet_proof = financial_signature(&f.alice, &prepared);
        let response = exchange(&root, mode, "signature", &wallet_proof);
        let auth = response["authorization"].clone();
        assert_eq!(auth["event"], f.event);
        assert_eq!(auth["rules_hash"], f.rules_hash);
        assert_eq!(auth["source"]["address"], f.alice.id().as_str());
        assert_eq!(f.fund(&f.alice, &auth, 5_000_000).await, "5000000");
        let funded = snapshot(&f, &auth).await;
        let candidate = exchange(&root, mode, "funded", &funded);
        let receipt = candidate["receipt"].clone();
        assert_eq!(receipt["event"], f.event);
        assert_eq!(receipt["registration"], auth["registration"]);
        assert_eq!(receipt["participant"], auth["participant"]);
        assert_eq!(
            receipt["proof_class"],
            if mode == "online" {
                "live_code"
            } else {
                "staff_qr"
            }
        );
        f.advance(receipt["received_ms"].as_u64().unwrap()).await;
        let signature = proof(&f.evidence, &receipt);
        let permission = exchange(
            &root,
            mode,
            "signed",
            &json!({"source":snapshot(&f,&auth).await,"receipt":receipt,"proof":signature,
            "evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes())}),
        );
        assert_eq!(permission["submit"], true);
        let accepted = f
            .bob
            .call(f.escrow.id(), "accept_attendance")
            .args_json(json!({"receipt":receipt,"proof":signature}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap();
        assert_eq!(accepted, "on_time");
        let acknowledged = exchange(
            &root,
            mode,
            "accepted",
            &json!({"source":snapshot(&f,&auth).await,"receipt":receipt,"proof":signature,
            "evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes())}),
        );
        assert_eq!(acknowledged["recovered"], true);
        f.advance(f.end - 600_000 + 1).await;
        f.host
            .call(f.escrow.id(), "record_end")
            .args_json(json!({"event":f.event}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let boundary = json!({"domain":"showup.sandbox.authorization.v1","deployment":f.escrow.id(),"manifest":"local-v1",
            "event":f.event,"rules_hash":f.rules_hash,"ledger_version":u64::MAX,"complete_through_ms":f.end-900_000,"expires_ms":f.end+2_100_000});
        let reconciled = exchange(
            &root,
            mode,
            "reconcile",
            &json!({"source":snapshot(&f,&auth).await,
            "receipt":receipt,"proof":signature,"evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes()),"u64BoundaryProof":proof(&f.evidence,&boundary)}),
        );
        let checkpoint: Value =
            serde_json::from_str(reconciled["checkpointWire"].as_str().unwrap()).unwrap();
        let checkpoint_proof = proof(&f.evidence, &checkpoint);
        let permission = exchange(
            &root,
            mode,
            "closing_signed",
            &json!({"source":snapshot(&f,&auth).await,"checkpointProof":checkpoint_proof}),
        );
        assert_eq!(permission["submit"], true);
        assert_eq!(
            f.bob
                .call(f.escrow.id(), "close")
                .args_json(json!({"checkpoint":checkpoint,"proof":checkpoint_proof}))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
                .json::<String>()
                .unwrap(),
            "closed"
        );
        let acknowledged = exchange(
            &root,
            mode,
            "closed",
            &json!({"source":snapshot(&f,&auth).await}),
        );
        assert_eq!(acknowledged["recovered"], true);
        let withdrawal = exchange(
            &root,
            mode,
            "principal_ready",
            &json!({"source":snapshot(&f,&auth).await}),
        );
        assert_eq!(
            withdrawal["liabilityId"],
            format!("{}:principal", auth["registration"].as_str().unwrap())
        );
        assert!(
            f.bob
                .call(f.escrow.id(), "withdraw")
                .args_json(
                    json!({"id":format!("{}:principal",auth["registration"].as_str().unwrap())})
                )
                .max_gas()
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
                .json::<bool>()
                .unwrap()
        );
        assert_eq!(f.balance(f.alice.id().as_str()).await, 100_000_000);
        let recovered = exchange(
            &root,
            mode,
            "principal_paid",
            &json!({"source":snapshot(&f,&auth).await}),
        );
        assert_eq!(recovered["recovered"], true);
        let result = json!({"receipt":receipt,"proof":signature,"evidencePublicKey":STANDARD.encode(f.evidence.verifying_key().to_bytes()),"checkpointProof":proof(&f.evidence,&checkpoint),"returned":snapshot(&f,&auth).await});
        let acknowledged = exchange(&root, mode, "returned", &result);
        assert_eq!(acknowledged["verified"], true);
        eprintln!("PASS: application financial consent, {mode} attendance and principal return");
    }
}
