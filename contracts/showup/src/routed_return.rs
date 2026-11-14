//! Sandbox return protocol. Quote authority, source submission and destination
//! evidence are separate; an unresolved send never becomes fresh spending power.
use crate::financial::{money, text};
use crate::routed_funding::{asset, timestamp};
use crate::*;
use near_sdk::serde_json::{Value, json};
use near_sdk::{Gas, NearToken, Promise, PromiseError, PromiseOrValue, ext_contract};

#[ext_contract(return_token)]
#[allow(dead_code)]
trait ReturnToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}
#[ext_contract(return_self)]
#[allow(dead_code)]
trait ReturnCallbacks {
    fn on_routed_return(&mut self, registration: String, number: u64) -> String;
    fn on_routed_refund_balance(&mut self, registration: String, number: u64) -> String;
}
fn digest<T: near_sdk::serde::Serialize>(value: &T) -> String {
    env::sha256(canonical::bytes(value))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn image(attempt: &RoutedReturn) -> String {
    digest(
        &json!({"format":"showup.routed-return.image.v1","number":attempt.number,
        "liability":attempt.liability,"quote_hash":attempt.quote_hash,"deposit":attempt.deposit,
        "destination":attempt.destination,"gross":attempt.gross,"quoted_net":attempt.quoted_net,
        "minimum_net":attempt.minimum_net,"refund_fee":attempt.refund_fee,"deadline_ms":attempt.deadline_ms}),
    )
}
fn current(ledger: &mut RoutedReturns, number: u64) -> &mut RoutedReturn {
    let attempt = ledger.attempts.last_mut().expect("No routed return");
    require!(attempt.number == number, "Stale return callback");
    attempt
}
fn pending(state: &str) -> bool {
    !["failed", "delivered", "refunded"].contains(&state)
}
fn fact(receipt: &ReturnObservation) -> String {
    let mut value = near_sdk::serde_json::to_value(receipt).unwrap();
    for key in [
        "block_height",
        "block_hash",
        "block_ms",
        "observed_ms",
        "expires_ms",
    ] {
        value.as_object_mut().unwrap().remove(key);
    }
    digest(&value)
}
fn hash(network: &str, value: &str, transaction: bool) {
    if network == "near" {
        require!(value.len() <= 44, "NEAR return hash bounds");
        let bytes = bs58::decode(value)
            .into_vec()
            .expect("Invalid NEAR return hash");
        require!(
            bytes.len() == 32 && bs58::encode(bytes).into_string() == value,
            "Invalid NEAR return hash"
        );
    } else {
        observer::hash(network, value, transaction);
    }
}

#[near]
impl Escrow {
    #[payable]
    pub fn route_return(&mut self, registration: String, kind: String, quote: String) -> Promise {
        require!(
            env::predecessor_account_id() == self.owner,
            "Return executor only"
        );
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Exactly one yocto required"
        );
        require!(
            ["principal", "return"].contains(&kind.as_str()),
            "Only original principal/refund liabilities"
        );
        let auth = self
            .registrations
            .get(&registration)
            .expect("Unknown registration")
            .authorization
            .clone();
        let event = self.events.get(&auth.event).unwrap();
        let policy = event
            .terms
            .routing_policy
            .as_ref()
            .expect("Routing policy missing")
            .clone();
        let returns = policy.returns.as_ref().expect("Returns remain disabled");
        require!(
            self.domain == "showup.sandbox.authorization.v1",
            "Routed return remains sandbox only"
        );
        let id = format!("{registration}:{kind}");
        let debt = self
            .liabilities
            .get(&id)
            .expect("No existing liability")
            .clone();
        require!(
            debt.pending.is_none() && debt.destination.network != "near",
            "Return pending or native destination"
        );
        require!(
            debt.destination
                == if kind == "principal" {
                    auth.payout.clone()
                } else {
                    auth.refund.clone()
                },
            "Original destination changed"
        );
        let gross = debt.total.0 - debt.paid.0;
        require!(gross > 0, "Already delivered");
        let mut ledger = self
            .routed_returns
            .get(&registration)
            .cloned()
            .unwrap_or_default();
        require!(
            !ledger.paused && ledger.attempts.iter().all(|a| !pending(&a.state)),
            "Prior return unresolved"
        );
        require!(
            ledger.attempts.iter().filter(|a| a.liability == id).count()
                < usize::from(returns.max_attempts),
            "Return attempt limit reached; debt preserved"
        );
        let remaining_fee = auth
            .fee_cap
            .0
            .checked_sub(ledger.fees_used.0)
            .expect("Fee budget exhausted");
        let envelope: Value = near_sdk::serde_json::from_str(
            auth.wallet_consent
                .as_ref()
                .expect("Original financial consent required"),
        )
        .unwrap();
        let payout_minimum = money(&envelope["consent"]["terms"]["payoutMinimum"]);
        let key: [u8; 32] = policy.quote_key.0.clone().try_into().unwrap();
        let (parsed, selected, quote_hash) = routing_quote::authenticate(&quote, &key);
        let request = parsed["quoteRequest"].as_object().unwrap();
        routing_quote::plain_route(request);
        require!(
            !request.contains_key("customRecipientMsg"),
            "Return cannot invoke a recipient callback"
        );
        let f = &selected.fields;
        let destination = asset(&policy, &debt.destination.network);
        require!(
            debt.destination.asset == destination.contract
                && request["dry"] == false
                && f["swapType"] == "EXACT_INPUT"
                && f["slippageTolerance"] == 100
                && f["depositType"] == "ORIGIN_CHAIN"
                && f["refundType"] == "ORIGIN_CHAIN"
                && f["recipientType"] == "DESTINATION_CHAIN"
                && f["originAsset"] == format!("nep141:{}", self.token)
                && f["destinationAsset"] == destination.route_asset
                && f["refundTo"] == env::current_account_id().as_str()
                && f["recipient"] == debt.destination.address
                && money(&f["amount"]) == gross
                && money(&f["amountIn"]) == gross
                && money(&f["minAmountIn"]) == gross,
            "Return quote changes its liability"
        );
        let minimum = money(&f["minAmountOut"]);
        let quoted = money(&f["amountOut"]);
        let refund_fee = money(&f["refundFee"]);
        require!(
            minimum >= payout_minimum
                && minimum <= quoted
                && quoted <= gross
                && gross - minimum <= remaining_fee
                && refund_fee <= remaining_fee
                && refund_fee < gross
                && money(&f["withdrawFee"]) <= gross - minimum,
            "Return fee or positive net limits exceeded"
        );
        let created = timestamp(&f["timestamp"]);
        let deadline = timestamp(&f["deadline"]);
        let requested = timestamp(&selected.request_deadline);
        require!(
            created <= now()
                && now() - created <= 60_000
                && deadline > now()
                && deadline <= requested
                && requested <= created.saturating_add(300_000),
            "Return quote expired or unbounded"
        );
        require!(!f.contains_key("depositMemo"), "Return memo unsupported");
        let deposit: AccountId = text(&f["depositAddress"])
            .parse()
            .expect("NEAR return deposit required");
        require!(
            deposit != env::current_account_id() && !self.routed_deposits.contains_key(&deposit),
            "Return deposit address reused"
        );
        let number = ledger.attempts.len() as u64 + 1;
        let attempt = RoutedReturn {
            number,
            liability: id.clone(),
            quote_hash,
            deposit: deposit.clone(),
            destination: debt.destination,
            gross: U128(gross),
            quoted_net: U128(quoted),
            minimum_net: U128(minimum),
            refund_fee: U128(refund_fee),
            deadline_ms: deadline,
            state: "submitting".into(),
            observation: None,
            conflict: None,
            balance_epoch: None,
            balance_checks: 0,
        };
        let image = image(&attempt);
        self.routed_deposits.insert(deposit.clone(), image.clone());
        ledger.attempts.push(attempt);
        self.routed_returns.insert(registration.clone(), ledger);
        let debt = self.liabilities.get_mut(&id).unwrap();
        debt.attempts += 1;
        debt.pending = Some(TransferAttempt {
            number: debt.attempts,
            amount: U128(gross),
        });
        self.routed_in_flight = self
            .routed_in_flight
            .checked_add(gross)
            .expect("In-flight overflow");
        self.money_changed();
        return_token::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(
                deposit,
                U128(gross),
                Some(format!("showup.return.v1:{image}")),
            )
            .then(
                return_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_routed_return(registration, number),
            )
    }

    #[private]
    pub fn on_routed_return(&mut self, registration: String, number: u64) -> String {
        require!(env::promise_results_count() == 1, "Invalid return callback");
        let ledger = self.routed_returns.get_mut(&registration).unwrap();
        let attempt = current(ledger, number);
        require!(
            attempt.state == "submitting",
            "Return callback already resolved"
        );
        attempt.state = if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            self.liabilities
                .get_mut(&attempt.liability)
                .unwrap()
                .pending = None;
            self.routed_in_flight -= attempt.gross.0;
            "failed"
        } else {
            "submitted"
        }
        .into();
        let state = attempt.state.clone();
        self.money_changed();
        state
    }

    pub fn get_routed_returns(&self, registration: String) -> Option<RoutedReturns> {
        self.routed_returns.get(&registration).cloned()
    }

    pub fn observe_routed_return(
        &mut self,
        receipt: ReturnObservation,
        proof: Base64VecU8,
    ) -> PromiseOrValue<RoutedReturns> {
        let auth = self
            .registrations
            .get(&receipt.registration)
            .expect("Unknown registration")
            .authorization
            .clone();
        let event = self.events.get(&auth.event).unwrap();
        let policy = event
            .terms
            .routing_policy
            .as_ref()
            .expect("Routing policy missing");
        let observer = &policy.returns.as_ref().expect("Returns disabled").observer;
        let key: [u8; 32] = observer.key.0.clone().try_into().unwrap();
        signature(&receipt, &proof, &key);
        require!(
            self.domain == "showup.sandbox.authorization.v1"
                && receipt.format == "showup.routed-return.observation.v1"
                && receipt.domain == self.domain
                && receipt.deployment == env::current_account_id()
                && receipt.manifest == self.manifest
                && receipt.event == auth.event
                && receipt.rules_hash == auth.rules_hash
                && receipt.profile_hash == observer.profile_hash
                && receipt.sources == observer.sources,
            "Return observation context mismatch"
        );
        let mut ledger = self
            .routed_returns
            .get(&receipt.registration)
            .expect("No routed return")
            .clone();
        let index = ledger
            .attempts
            .iter()
            .position(|a| a.number == receipt.number)
            .expect("Unknown return attempt");
        let attempt = ledger.attempts[index].clone();
        require!(
            receipt.image_hash == image(&attempt) && receipt.liability == attempt.liability,
            "Return observation changes its image"
        );
        let refunded = receipt.kind == "refunded";
        require!(
            refunded || receipt.kind == "delivered",
            "Invalid return outcome"
        );
        let network = if refunded {
            "near"
        } else {
            attempt.destination.network.as_str()
        };
        let asset = asset(policy, network);
        let refund_recipient = env::current_account_id();
        require!(
            receipt.network == network
                && receipt.chain_id == asset.chain_id
                && receipt.asset == asset.contract
                && receipt.recipient
                    == if refunded {
                        refund_recipient.as_str()
                    } else {
                        &attempt.destination.address
                    },
            "Return observation changes its destination"
        );
        if attempt
            .observation
            .as_ref()
            .is_some_and(|old| old == &receipt)
        {
            return PromiseOrValue::Value(ledger);
        }
        require!(
            receipt.finalized
                && receipt.transaction_block_height.0 > 0
                && receipt.transaction_block_height.0 <= receipt.block_height.0
                && receipt.transaction_ms > 0
                && receipt.transaction_ms <= receipt.block_ms
                && receipt.block_ms <= receipt.observed_ms
                && receipt.observed_ms <= now()
                && now() - receipt.observed_ms <= 60_000
                && receipt.observed_ms - receipt.block_ms
                    <= if network == "solana" {
                        120_000
                    } else {
                        1_800_000
                    }
                && receipt.expires_ms > now()
                && receipt.expires_ms > receipt.observed_ms
                && receipt.expires_ms - receipt.observed_ms <= 60_000,
            "Stale or insufficiently final return observation"
        );
        hash(network, &receipt.transaction, true);
        hash(network, &receipt.block_hash, false);
        hash(network, &receipt.transaction_block_hash, false);
        require!(
            receipt.transaction_block_height != receipt.block_height
                || receipt.transaction_block_hash == receipt.block_hash,
            "Return inclusion block mismatch"
        );
        if let Some(old) = &attempt.observation {
            if fact(old) == fact(&receipt) {
                return PromiseOrValue::Value(ledger);
            }
            ledger.paused = true;
            ledger.attempts[index].conflict = Some(receipt.clone());
            if pending(&attempt.state) {
                ledger.attempts[index].state = "review_required".into();
            }
            self.routed_returns
                .insert(receipt.registration, ledger.clone());
            return PromiseOrValue::Value(ledger);
        }
        require!(
            attempt.state == "submitted" && !ledger.paused,
            "Return is not awaiting evidence"
        );
        let identity = format!(
            "{}:{}:{}:{}:{}",
            network, receipt.chain_id, receipt.asset, receipt.transaction, receipt.event_index
        );
        let duplicate = self
            .return_receipts
            .get(&identity)
            .is_some_and(|old| old != &receipt.image_hash);
        let fee = attempt.gross.0.checked_sub(receipt.amount.0);
        let within = fee.is_some_and(|fee| {
            fee <= auth.fee_cap.0.saturating_sub(ledger.fees_used.0)
                && if refunded {
                    fee <= attempt.refund_fee.0
                } else {
                    receipt.amount.0 >= attempt.minimum_net.0
                }
        });
        ledger.attempts[index].observation = Some(receipt.clone());
        if duplicate || !within || receipt.amount.0 == 0 {
            ledger.paused = true;
            ledger.attempts[index].state = "review_required".into();
            self.routed_returns
                .insert(receipt.registration, ledger.clone());
            return PromiseOrValue::Value(ledger);
        }
        self.return_receipts
            .insert(identity, receipt.image_hash.clone());
        self.routed_returns
            .insert(receipt.registration.clone(), ledger);
        if refunded {
            self.start_refund_check(receipt.registration.clone(), receipt.number);
            PromiseOrValue::Promise(self.refund_balance(receipt.registration, receipt.number))
        } else {
            self.finish_routed_return(&receipt.registration, receipt.number, false);
            PromiseOrValue::Value(
                self.routed_returns
                    .get(&receipt.registration)
                    .unwrap()
                    .clone(),
            )
        }
    }

    pub fn recheck_routed_refund(&mut self, registration: String, number: u64) -> Promise {
        require!(
            env::predecessor_account_id() == self.owner,
            "Return executor only"
        );
        let ledger = self.routed_returns.get(&registration).unwrap();
        require!(
            !ledger.paused
                && ledger
                    .attempts
                    .last()
                    .is_some_and(|a| a.number == number && a.state == "refund_check_needed"),
            "Refund is not awaiting reconciliation"
        );
        self.start_refund_check(registration.clone(), number);
        self.refund_balance(registration, number)
    }

    #[private]
    pub fn on_routed_refund_balance(&mut self, registration: String, number: u64) -> String {
        require!(
            env::promise_results_count() == 1,
            "Invalid refund balance callback"
        );
        let ledger = self.routed_returns.get_mut(&registration).unwrap();
        let attempt = current(ledger, number);
        require!(
            attempt.state == "checking_refund",
            "Stale refund balance callback"
        );
        let expected = (self.received - self.delivered - self.routed_in_flight)
            .checked_add(attempt.observation.as_ref().unwrap().amount.0)
            .expect("Refund balance overflow");
        let balance = env::promise_result_checked(0, 128)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice::<U128>(&bytes).ok());
        if attempt.balance_epoch != Some(self.financial_epoch)
            || balance.is_none_or(|value| value.0 < expected)
        {
            attempt.state = if attempt.balance_checks < 3 {
                "refund_check_needed"
            } else {
                "review_required"
            }
            .into();
            let paused = attempt.balance_checks >= 3;
            let state = attempt.state.clone();
            ledger.paused |= paused;
            return state;
        }
        self.finish_routed_return(&registration, number, true);
        "refunded".into()
    }
}

impl Escrow {
    fn start_refund_check(&mut self, registration: String, number: u64) {
        let ledger = self.routed_returns.get_mut(&registration).unwrap();
        let attempt = current(ledger, number);
        require!(
            attempt.balance_checks < 3,
            "Refund read limit reached; debt preserved"
        );
        attempt.balance_checks += 1;
        attempt.balance_epoch = Some(self.financial_epoch);
        attempt.state = "checking_refund".into();
    }

    fn finish_routed_return(&mut self, registration: &String, number: u64, refunded: bool) {
        let ledger = self.routed_returns.get_mut(registration).unwrap();
        let attempt = current(ledger, number);
        let received = attempt.observation.as_ref().unwrap().amount.0;
        let fee = attempt.gross.0 - received;
        let settled = if refunded { fee } else { attempt.gross.0 };
        let debt = self.liabilities.get_mut(&attempt.liability).unwrap();
        require!(
            debt.pending
                .as_ref()
                .is_some_and(|p| p.amount == attempt.gross),
            "Return debt image changed"
        );
        debt.pending = None;
        debt.paid.0 = debt
            .paid
            .0
            .checked_add(settled)
            .expect("Settled amount overflow");
        self.owed -= settled;
        self.delivered += settled;
        self.routed_in_flight -= attempt.gross.0;
        attempt.state = if refunded { "refunded" } else { "delivered" }.into();
        ledger.fees_used.0 = ledger.fees_used.0.checked_add(fee).expect("Fee overflow");
        self.money_changed();
    }

    fn refund_balance(&self, registration: String, number: u64) -> Promise {
        return_token::ext(self.token.clone())
            .with_static_gas(Gas::from_tgas(10))
            .ft_balance_of(env::current_account_id())
            .then(
                return_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_routed_refund_balance(registration, number),
            )
    }
}
