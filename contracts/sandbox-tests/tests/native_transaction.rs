use base64::{Engine, engine::general_purpose::STANDARD};
use near_primitives::transaction::{Action, Transaction};
use serde_json::Value;

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
