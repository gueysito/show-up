use crate::*;
use near_sdk::{Gas, NearToken, Promise, PromiseError, ext_contract};

#[ext_contract(ext_token)]
#[allow(dead_code)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_transfer(&mut self, id: String, number: u64, amount: U128) -> bool;
}

#[near]
impl Escrow {
    pub fn withdraw(&mut self, id: String) -> Promise {
        let item = self.liabilities.get_mut(&id).expect("Unknown liability");
        require!(item.pending.is_none(), "Transfer already pending");
        let amount = item.total.0 - item.paid.0;
        require!(amount > 0, "Already delivered");
        // A cross-chain address can never become an arbitrary NEAR transfer target.
        require!(
            item.destination.network == "near" && item.destination.asset == self.token.as_str(),
            "External delivery unqualified; liability preserved"
        );
        let receiver: AccountId = item.destination.address.parse().expect("Invalid receiver");
        item.attempts += 1;
        let number = item.attempts;
        item.pending = Some(TransferAttempt {
            number,
            amount: U128(amount),
        });
        ext_token::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(receiver, U128(amount), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_transfer(id, number, U128(amount)),
            )
    }

    #[private]
    pub fn on_transfer(&mut self, id: String, number: u64, amount: U128) -> bool {
        require!(env::promise_results_count() == 1, "Invalid callback");
        let item = self.liabilities.get_mut(&id).expect("Unknown liability");
        let pending = item.pending.as_ref().expect("No pending attempt");
        require!(
            pending.number == number && pending.amount == amount,
            "Stale callback"
        );
        item.pending = None;
        // TooLong means successful execution. Never retry a successful transfer
        // because its return body was large; read zero bytes to bound callback cost.
        if !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            item.paid.0 += amount.0;
            self.owed -= amount.0;
            self.delivered += amount.0;
            true
        } else {
            false
        }
    }
}

impl Escrow {
    pub(crate) fn add_liability(&mut self, id: String, destination: Destination, amount: u128) {
        require!(amount > 0, "Empty liability");
        if let Some(item) = self.liabilities.get_mut(&id) {
            require!(item.destination == destination, "Destination immutable");
            item.total.0 = item.total.0.checked_add(amount).expect("Amount overflow");
        } else {
            self.liabilities.insert(
                id,
                Liability {
                    destination,
                    total: U128(amount),
                    paid: U128(0),
                    attempts: 0,
                    pending: None,
                },
            );
        }
        self.owed = self.owed.checked_add(amount).expect("Amount overflow");
    }
}
