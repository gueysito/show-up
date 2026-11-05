use base64::{Engine, engine::general_purpose::STANDARD};
use near_primitives::transaction::{Action, Transaction};
use serde_json::Value;

#[test]
fn sponsored_intents_withdrawal_matches_nep366_wire_and_signature_domain() {
    // Public encoder fixture uses an explicitly invalid zero signature. No
    // operator signature/key is needed to check the exact NEAR signing digest.
    let vector: Value =
        serde_json::from_str(include_str!("../fixtures/v1-sponsored-withdrawal.json")).unwrap();
    let bytes = STANDARD
        .decode(vector["unsignedBase64"].as_str().unwrap())
        .unwrap();
    let tx: Transaction = borsh::from_slice(&bytes).unwrap();
    assert_eq!(tx.get_hash_and_size().0.to_string(), vector["hash"]);
    assert_eq!(
        tx.signer_id().as_str(),
        "14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc"
    );
    assert_eq!(
        tx.receiver_id().as_str(),
        "r6c6d5471a0e74941bb3732f131270000.showup-dev-14989f.near"
    );
    assert_eq!(tx.nonce().nonce(), 9_007_199_254_740_993);
    assert_eq!(tx.actions().len(), 1);
    let Action::Delegate(signed) = &tx.actions()[0] else {
        panic!("NEP-366 delegate expected")
    };
    let delegate = &signed.delegate_action;
    assert_eq!(delegate.sender_id, *tx.receiver_id());
    assert_eq!(delegate.receiver_id.as_str(), "intents.near");
    assert_eq!(delegate.public_key, *tx.public_key());
    assert_eq!(delegate.nonce, 9_007_199_254_740_994);
    assert_eq!(delegate.max_block_height, 340);
    let digest = delegate
        .get_nep461_hash()
        .0
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, vector["delegateDigest"]);
    assert!(!signed.verify());
    let actions = delegate
        .actions
        .iter()
        .cloned()
        .map(Action::from)
        .collect::<Vec<_>>();
    assert_eq!(actions.len(), 1);
    let Action::FunctionCall(call) = &actions[0] else {
        panic!("Fixed withdrawal expected")
    };
    assert_eq!(call.method_name, "ft_withdraw");
    assert_eq!(call.gas.as_gas(), 100_000_000_000_000);
    assert_eq!(call.deposit.as_yoctonear(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&call.args).unwrap(),
        serde_json::json!({
            "token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            "receiver_id":"showup-dev-14989f.near", "amount":"1000000", "memo":null,
            "msg":"deposit:6c6d5471-a0e7-4941-bb37-32f131270000"
        })
    );
    assert_eq!(borsh::to_vec(&tx).unwrap(), bytes);
}

#[test]
fn v1_native_usdc_payment_matches_pinned_near_wire_format() {
    for (raw, prefix) in [
        (
            include_str!("../fixtures/v1-prize-transaction.json"),
            "prize",
        ),
        (
            include_str!("../fixtures/v1-deposit-transaction.json"),
            "deposit",
        ),
    ] {
        let vector: Value = serde_json::from_str(raw).unwrap();
        let bytes = STANDARD
            .decode(vector["unsignedBase64"].as_str().unwrap())
            .unwrap();
        let tx: Transaction = borsh::from_slice(&bytes).unwrap();
        assert_eq!(tx.get_hash_and_size().0.to_string(), vector["hash"]);
        assert_eq!(tx.signer_id().as_str(), "host.near");
        assert_eq!(
            tx.receiver_id().as_str(),
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        );
        assert_eq!(tx.nonce().nonce(), 9_007_199_254_740_993);
        assert_eq!(tx.public_key().to_string(), vector["publicKey"]);
        assert_eq!(tx.block_hash().to_string(), vector["blockHash"]);
        assert_eq!(tx.actions().len(), 1);
        let Action::FunctionCall(call) = &tx.actions()[0] else {
            panic!("Fixed prize funding expected")
        };
        assert_eq!(call.method_name, "ft_transfer_call");
        assert_eq!(call.gas.as_gas(), 100_000_000_000_000);
        assert_eq!(call.deposit.as_yoctonear(), 1);
        let args: Value = serde_json::from_slice(&call.args).unwrap();
        assert_eq!(
            args,
            serde_json::json!({"receiver_id":"showup-dev-14989f.near","amount":"1250000","msg":format!("{prefix}:1ff96e01-b3dd-439c-9762-a99ce5af7213")})
        );
        assert_eq!(borsh::to_vec(&tx).unwrap(), bytes);
    }
}

// The application encoder is independently decoded by the pinned native NEAR
// implementation. This fixture contains public bytes only, with no signing key.
#[test]
fn native_engineering_transaction_matches_pinned_near_wire_format() {
    let vector: Value =
        serde_json::from_str(include_str!("../fixtures/native-transaction.json")).unwrap();
    let bytes = STANDARD
        .decode(vector["unsignedBase64"].as_str().unwrap())
        .unwrap();
    let tx: Transaction = borsh::from_slice(&bytes).unwrap();
    assert_eq!(tx.get_hash_and_size().0.to_string(), vector["hash"]);
    assert_eq!(tx.signer_id().as_str(), "root.testnet");
    assert_eq!(tx.receiver_id().as_str(), "a.root.testnet");
    assert_eq!(tx.public_key().to_string(), vector["publicKey"]);
    assert_eq!(tx.nonce().nonce(), 9_007_199_254_740_993);
    assert_eq!(tx.block_hash().to_string(), vector["blockHash"]);
    let actions = tx.actions();
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[0], Action::CreateAccount(_)));
    let Action::Transfer(transfer) = &actions[1] else {
        panic!("Transfer expected")
    };
    assert_eq!(
        transfer.deposit.as_yoctonear(),
        12_500_000_000_000_000_000_000_000
    );
    let Action::AddKey(key) = &actions[2] else {
        panic!("FullAccess child key expected")
    };
    assert_eq!(key.public_key, *tx.public_key());
    assert_eq!(key.access_key.nonce, 0);
    assert!(matches!(
        key.access_key.permission,
        near_primitives::account::AccessKeyPermission::FullAccess
    ));
    let Action::FunctionCall(call) = &actions[3] else {
        panic!("Fixed token transfer expected")
    };
    assert_eq!(call.method_name, "ft_transfer");
    assert_eq!(
        call.args,
        br#"{"amount":"5000000","receiver_id":"root.testnet"}"#
    );
    assert_eq!(call.gas.as_gas(), 300_000_000_000_000);
    assert_eq!(call.deposit.as_yoctonear(), 1);
    assert_eq!(borsh::to_vec(&tx).unwrap(), bytes);
}

#[test]
fn v1_mainnet_images_match_pinned_near_wire_format() {
    let vectors: Value =
        serde_json::from_str(include_str!("../fixtures/v1-mainnet-transactions.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        let bytes = STANDARD
            .decode(vector["unsignedBase64"].as_str().unwrap())
            .unwrap();
        let tx: Transaction = borsh::from_slice(&bytes).unwrap();
        assert_eq!(tx.get_hash_and_size().0.to_string(), vector["hash"]);
        assert_eq!(tx.public_key().to_string(), vector["publicKey"]);
        assert_eq!(tx.nonce().nonce(), 9_007_199_254_740_993);
        assert_eq!(tx.signer_id().as_str(), vector["signer"]);
        assert_eq!(tx.receiver_id().as_str(), vector["receiver"]);
        let actions = tx.actions();
        if vector["name"] == "unwrap" {
            assert_eq!(tx.receiver_id().as_str(), "wrap.near");
            assert_eq!(actions.len(), 1);
            let Action::FunctionCall(call) = &actions[0] else {
                panic!("Unwrap expected")
            };
            assert_eq!(call.method_name, "near_withdraw");
            let args: Value = serde_json::from_slice(&call.args).unwrap();
            assert_eq!(args["amount"], "3730000000000000000000000");
            assert_eq!(call.deposit.as_yoctonear(), 1);
            assert_eq!(call.gas.as_gas(), 40_000_000_000_000);
        } else {
            assert_eq!(tx.signer_id(), tx.receiver_id());
            assert_eq!(actions.len(), 2);
            let Action::DeployContract(deploy) = &actions[0] else {
                panic!("Deploy expected")
            };
            assert_eq!(deploy.code, vec![0, 97, 115, 109, 1, 0, 0, 0]);
            let Action::FunctionCall(call) = &actions[1] else {
                panic!("Initialization expected")
            };
            assert_eq!(call.method_name, "new");
            let args: Value = serde_json::from_slice(&call.args).unwrap();
            assert_eq!(
                args["owner"],
                "14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc"
            );
            assert_eq!(
                args["token"],
                "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
            );
            assert_eq!(args["signer"], "v1.signer");
            assert_eq!(call.deposit.as_yoctonear(), 0);
        }
        assert_eq!(borsh::to_vec(&tx).unwrap(), bytes);
    }
}
