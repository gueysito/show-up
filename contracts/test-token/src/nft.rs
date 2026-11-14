use crate::*;
use near_sdk::serde_json::{Value, json};

#[ext_contract(ext_nft_receiver)]
#[allow(dead_code)]
trait NftReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> bool;
}
#[ext_contract(ext_nft_resolver)]
#[allow(dead_code)]
trait NftResolver {
    fn nft_resolve_transfer(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
    ) -> bool;
}

#[near]
impl TestToken {
    pub fn mint_nft(&mut self, owner_id: AccountId, token_id: String) {
        require!(
            env::predecessor_account_id() == self.owner
                && !token_id.is_empty()
                && token_id.len() <= 256
                && !self.nft_owners.contains_key(&token_id),
            "Invalid test mint"
        );
        self.nft_owners.insert(token_id, owner_id);
    }
    pub fn set_fail_nft(&mut self, fail: bool) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Test owner only"
        );
        self.fail_nft = fail;
    }
    pub fn nft_token(&self, token_id: String) -> Option<Value> {
        self.nft_owners
            .get(&token_id)
            .map(|owner| json!({"token_id":token_id,"owner_id":owner}))
    }
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) -> Value {
        let _ = memo;
        require!(!self.fail_nft, "Injected test transfer failure");
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1) && approval_id.is_none(),
            "Invalid NFT call"
        );
        self.move_nft(&env::predecessor_account_id(), &receiver_id, &token_id);
        if self.reply_size == 0 {
            Value::Null
        } else {
            Value::String("x".repeat(self.reply_size as usize))
        }
    }
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        let _ = memo;
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1) && approval_id.is_none(),
            "Invalid NFT call"
        );
        let owner = env::predecessor_account_id();
        self.move_nft(&owner, &receiver_id, &token_id);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(100))
            .nft_on_transfer(owner.clone(), owner.clone(), token_id.clone(), msg)
            .then(
                ext_nft_resolver::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .nft_resolve_transfer(owner, receiver_id, token_id),
            )
    }
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
    ) -> bool {
        require!(env::promise_results_count() == 1, "Invalid test callback");
        let must_return = match env::promise_result_checked(0, 128) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(true),
            _ => true,
        };
        if must_return && self.nft_owners.get(&token_id) == Some(&receiver_id) {
            self.nft_owners.insert(token_id, owner_id);
            false
        } else {
            true
        }
    }
}
impl TestToken {
    fn move_nft(&mut self, from: &AccountId, to: &AccountId, token_id: &String) {
        require!(
            from != to && self.nft_owners.get(token_id) == Some(from),
            "NFT owner only"
        );
        self.nft_owners.insert(token_id.clone(), to.clone());
    }
}
