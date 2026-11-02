//! Test-only NEP-141/NEP-171 transfer/callback harness. Never a production asset.
mod nft;
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, ext_contract, near,
    require, store::LookupMap,
};

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait Receiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn resolve(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestToken {
    owner: AccountId,
    balances: LookupMap<AccountId, u128>,
    reply_size: u32,
    nft_owners: LookupMap<String, AccountId>,
    fail_nft: bool,
}

#[near]
impl TestToken {
    #[init]
    pub fn new() -> Self {
        Self {
            owner: env::predecessor_account_id(),
            balances: LookupMap::new(b"b"),
            reply_size: 0,
            nft_owners: LookupMap::new(b"n"),
            fail_nft: false,
        }
    }

    pub fn register(&mut self, account: AccountId) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Test owner only"
        );
        if !self.balances.contains_key(&account) {
            self.balances.insert(account, 0);
        }
    }

    pub fn mint(&mut self, account: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Test owner only"
        );
        *self
            .balances
            .get_mut(&account)
            .expect("Unregistered account") += amount.0;
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(*self.balances.get(&account_id).unwrap_or(&0))
    }

    #[payable]
    pub fn ft_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> near_sdk::serde_json::Value {
        let _ = memo;
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "One yocto required"
        );
        self.transfer(&env::predecessor_account_id(), &receiver_id, amount.0);
        if self.reply_size == 0 {
            near_sdk::serde_json::Value::Null
        } else {
            near_sdk::serde_json::Value::String("x".repeat(self.reply_size as usize))
        }
    }

    pub fn set_reply_size(&mut self, bytes: u32) {
        require!(
            env::predecessor_account_id() == self.owner && bytes <= 32768,
            "Invalid test response size"
        );
        self.reply_size = bytes;
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        msg: String,
    ) -> Promise {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "One yocto required"
        );
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(100))
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .resolve(sender, receiver_id, amount),
            )
    }

    #[private]
    pub fn resolve(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 128) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .map_or(amount.0, |value| value.0.min(amount.0)),
            _ => amount.0,
        };
        let refund = unused.min(*self.balances.get(&receiver_id).unwrap_or(&0));
        if refund > 0 {
            self.transfer(&receiver_id, &sender_id, refund);
        }
        U128(amount.0 - refund)
    }
}

impl TestToken {
    fn transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        require!(sender != receiver && amount > 0, "Invalid transfer");
        require!(
            self.balances.contains_key(receiver),
            "Unregistered receiver"
        );
        let balance = self.balances.get_mut(sender).expect("Unregistered sender");
        require!(*balance >= amount, "Insufficient balance");
        *balance -= amount;
        *self.balances.get_mut(receiver).unwrap() += amount;
    }
}
