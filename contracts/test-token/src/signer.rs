//! Disposable ABI mock. It returns precomputed public responses, never a key.
use crate::*;
use near_sdk::serde_json::{Value, json};

#[near]
impl TestToken {
    pub fn configure_signer(&mut self, configuration: Value) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Test owner only"
        );
        let encoded = near_sdk::serde_json::to_string(&configuration).unwrap();
        require!(encoded.len() <= 8192, "Mock configuration bounds");
        self.signer_configuration = Some(encoded);
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
    ) -> String {
        let config: Value =
            near_sdk::serde_json::from_str(self.signer_configuration.as_ref().unwrap()).unwrap();
        require!(
            config["caller"] == json!(env::predecessor_account_id())
                && predecessor == env::predecessor_account_id()
                && config["path"] == path
                && config["domain_id"] == domain_id,
            "Mock derivation context mismatch"
        );
        config["public_key"].as_str().unwrap().into()
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        let config: Value =
            near_sdk::serde_json::from_str(self.signer_configuration.as_ref().unwrap()).unwrap();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Mock signing deposit mismatch"
        );
        require!(
            config["caller"] == json!(env::predecessor_account_id())
                && config["request"] == request,
            "Mock sign context mismatch"
        );
        self.signer_calls += 1;
        self.signer_trace = Some(
            near_sdk::serde_json::to_string(
                &json!({"caller":env::predecessor_account_id(),"request":request,
            "deposit":"1"}),
            )
            .unwrap(),
        );
        if config["failure"] == true {
            env::panic_str("Simulated provider timeout");
        }
        config["response"].clone()
    }

    pub fn get_signer_trace(&self) -> Value {
        json!({"calls":self.signer_calls,"last":self.signer_trace.as_ref().map(|value| near_sdk::serde_json::from_str::<Value>(value).unwrap())})
    }
}
