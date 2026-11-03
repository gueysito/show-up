//! Bounded sandbox recovery proof. No MPC request or broadcaster is exposed.
//! Observer state cannot change the intent or release earlier fee reservations.
use crate::*;

#[near]
impl Escrow {
    pub fn recover_evm_custody(
        &mut self,
        receipt: CustodyRecovery,
        proof: Base64VecU8,
        envelope: EvmCustodyEnvelope,
    ) -> CustodyImage {
        let image = self.evm_image(&receipt.event, &envelope);
        if let Some(replay) = self.recovery_replay(&receipt, &proof, &image) {
            return replay;
        }
        let previous = self.custody_images.get(&receipt.event).unwrap();
        let nonce = previous
            .execution
            .evm_nonce
            .expect("Wrong recovery family")
            .0;
        require!(
            receipt.finalized_block_height.is_none()
                && receipt.blockhash_valid.is_none()
                && receipt.new_blockhash_valid.is_none()
                && !receipt.signature_status_absent,
            "Unexpected EVM recovery fields"
        );
        match receipt.reason.as_str() {
            "same_nonce" => {
                require!(
                    receipt.account_nonce.is_some_and(|value| value.0 == nonce)
                        && envelope.nonce == nonce
                        && !receipt.transaction_failed
                        && receipt.failed_image_hash.is_none()
                        && receipt.transaction.is_none()
                        && receipt.transaction_block_height.is_none()
                        && receipt.transaction_block_hash.is_none()
                        && receipt.reported_fee.0 == 0,
                    "Uncertain EVM nonce cannot advance"
                );
                let old_max = previous.execution.evm_max_fee.unwrap().0;
                let old_tip = previous.execution.evm_priority_fee.unwrap().0;
                require!(
                    envelope.max_fee_per_gas.0 >= old_max
                        && envelope.max_priority_fee_per_gas.0 >= old_tip
                        && (envelope.max_fee_per_gas.0 > old_max
                            || envelope.max_priority_fee_per_gas.0 > old_tip),
                    "Replacement must increase its bounded fee offer"
                );
            }
            "failed_nonce" => {
                let next = nonce.checked_add(1).expect("Nonce overflow");
                require!(
                    receipt.account_nonce.is_some_and(|value| value.0 == next)
                        && envelope.nonce == next,
                    "Next nonce requires reconciled consumption"
                );
                let failed = self.failed_recovery_image(&receipt);
                require!(
                    failed.execution.evm_nonce == previous.execution.evm_nonce,
                    "Failed transaction has another nonce"
                );
            }
            _ => env::panic_str("Unapproved EVM recovery reason"),
        }
        self.commit_recovery(receipt, image)
    }

    pub fn recover_solana_custody(
        &mut self,
        receipt: CustodyRecovery,
        proof: Base64VecU8,
        envelope: SolanaCustodyEnvelope,
    ) -> CustodyImage {
        let image = self.solana_image(&receipt.event, &envelope);
        if let Some(replay) = self.recovery_replay(&receipt, &proof, &image) {
            return replay;
        }
        let previous = self.custody_images.get(&receipt.event).unwrap();
        let height = receipt
            .finalized_block_height
            .expect("Final block height missing")
            .0;
        require!(
            height > 0
                && height <= receipt.block_height.0
                && receipt.account_nonce.is_none()
                && receipt.new_blockhash_valid == Some(true)
                && envelope.last_valid_block_height.0 > height
                && height
                    .checked_add(150)
                    .is_some_and(|limit| envelope.last_valid_block_height.0 <= limit),
            "Fresh bounded Solana blockhash witness missing"
        );
        require!(
            self.custody_history
                .get(&receipt.event)
                .unwrap()
                .iter()
                .all(|old| old.execution.solana_blockhash.as_ref() != Some(&envelope.blockhash)),
            "Cannot reuse a signing blockhash"
        );
        match receipt.reason.as_str() {
            "solana_expired" => {
                require!(
                    receipt.blockhash_valid == Some(false)
                        && receipt.signature_status_absent
                        && height
                            > previous
                                .execution
                                .last_valid_block_height
                                .expect("Old expiry missing")
                                .0
                        && !receipt.transaction_failed
                        && receipt.failed_image_hash.is_none()
                        && receipt.transaction_block_height.is_none()
                        && receipt.transaction_block_hash.is_none()
                        && receipt.reported_fee.0 == 0,
                    "Missing expiry/status reconciliation"
                );
                observer::hash(
                    "solana",
                    receipt
                        .transaction
                        .as_deref()
                        .expect("Original signature required for history reconciliation"),
                    true,
                );
            }
            "solana_failed" => {
                require!(
                    !receipt.signature_status_absent && receipt.blockhash_valid.is_some(),
                    "Failed status witness missing"
                );
                let failed = self.failed_recovery_image(&receipt);
                require!(
                    custody::image_hash(&failed) == custody::image_hash(previous),
                    "Failure does not resolve the current image"
                );
            }
            _ => env::panic_str("Unapproved Solana recovery reason"),
        }
        self.commit_recovery(receipt, image)
    }
}

impl Escrow {
    fn recovery_replay(
        &self,
        receipt: &CustodyRecovery,
        proof: &Base64VecU8,
        image: &CustodyImage,
    ) -> Option<CustodyImage> {
        let event = self
            .events
            .get(&receipt.event)
            .expect("Unknown recovery event");
        let intent = self
            .custody_intents
            .get(&receipt.event)
            .expect("No fixed custody intent");
        let policy = event
            .terms
            .observer_policy
            .as_ref()
            .expect("Observer profile missing");
        let key: [u8; 32] = policy.key.0.clone().try_into().unwrap();
        signature(receipt, proof, &key);
        require!(
            receipt.format == "showup.custody.recovery.v1"
                && receipt.domain == self.domain
                && receipt.deployment == env::current_account_id()
                && receipt.manifest == intent.manifest
                && receipt.rules_hash == event.terms.rules_hash
                && receipt.network == intent.network
                && receipt.chain_id == observer::chain(&intent.network)
                && receipt.profile_hash == policy.profile_hash
                && receipt.sources == policy.sources
                && receipt.intent_hash == image.intent_hash
                && receipt.new_envelope_hash == image.envelope_hash
                && receipt.owner == intent.source
                && valid_id(&receipt.nonce),
            "Recovery context mismatch"
        );
        let replay_key = format!("custody-recovery:{}:{}", receipt.event, receipt.nonce);
        if let Some(hash) = self.nonces.get(&replay_key) {
            let (recorded, image_hash) = hash.split_once(':').expect("Recovery receipt index");
            require!(
                recorded == custody::record_hash(receipt),
                "Recovery nonce payload changed"
            );
            return Some(
                self.custody_history
                    .get(&receipt.event)
                    .unwrap()
                    .iter()
                    .find(|old| custody::image_hash(old) == image_hash)
                    .expect("Recovery image missing")
                    .clone(),
            );
        }
        require!(
            !self
                .observations
                .get(&receipt.event)
                .is_some_and(|state| state.delivered),
            "Custody delivery already recorded"
        );
        let previous = self
            .custody_images
            .get(&receipt.event)
            .expect("No original signing image");
        require!(
            receipt.previous_image_hash == custody::image_hash(previous),
            "Recovery references another current image"
        );
        require!(
            receipt.block_height.0 > 0
                && receipt.block_ms <= receipt.observed_ms
                && receipt.observed_ms <= now()
                && now() - receipt.observed_ms <= 60_000
                && receipt.observed_ms - receipt.block_ms
                    <= if intent.network == "solana" {
                        120_000
                    } else {
                        1_800_000
                    }
                && receipt.expires_ms > now()
                && receipt.expires_ms > receipt.observed_ms
                && receipt.expires_ms - receipt.observed_ms <= 60_000,
            "Stale recovery observation"
        );
        observer::hash(&intent.network, &receipt.block_hash, false);
        None
    }

    fn failed_recovery_image(&self, receipt: &CustodyRecovery) -> CustodyImage {
        require!(
            receipt.transaction_failed && !receipt.signature_status_absent,
            "Confirmed failed transaction required"
        );
        let hash = receipt
            .failed_image_hash
            .as_ref()
            .expect("Failed image missing");
        let image = self
            .custody_history
            .get(&receipt.event)
            .unwrap()
            .iter()
            .find(|image| custody::image_hash(image) == *hash)
            .expect("Unknown failed signing image")
            .clone();
        observer::hash(
            &receipt.network,
            receipt
                .transaction
                .as_deref()
                .expect("Failed transaction missing"),
            true,
        );
        require!(
            receipt
                .transaction_block_height
                .is_some_and(|height| height.0 > 0 && height.0 <= receipt.block_height.0),
            "Failure inclusion is not finalized"
        );
        observer::hash(
            &receipt.network,
            receipt
                .transaction_block_hash
                .as_deref()
                .expect("Failed inclusion hash missing"),
            false,
        );
        if receipt.transaction_block_height == Some(receipt.block_height) {
            require!(
                receipt.transaction_block_hash.as_ref() == Some(&receipt.block_hash),
                "Failure block hash mismatch"
            );
        }
        require!(
            receipt.reported_fee.0 <= image.execution.fee_exposure.0,
            "Failure fee exceeds its reserved bound"
        );
        image
    }

    fn commit_recovery(
        &mut self,
        receipt: CustodyRecovery,
        mut image: CustodyImage,
    ) -> CustodyImage {
        let intent = self.custody_intents.get(&receipt.event).unwrap();
        let previous = self.custody_images.get(&receipt.event).unwrap();
        let history = self.custody_history.get(&receipt.event).unwrap();
        require!(history.len() < 3, "Bounded custody experiment exhausted");
        let old_exposure = if let Some(nonce) = image.execution.evm_nonce {
            history
                .iter()
                .filter(|old| old.execution.evm_nonce == Some(nonce))
                .map(|old| old.execution.fee_exposure.0)
                .max()
                .unwrap_or(0)
        } else {
            0
        };
        let additional = image.execution.fee_exposure.0.saturating_sub(old_exposure);
        let reserved = previous
            .reserved_fee
            .0
            .checked_add(additional)
            .expect("Fee reservation overflow");
        require!(
            reserved <= intent.fee_cap.0,
            "Custody fee reservation exhausted"
        );
        image.generation = u8::try_from(history.len() + 1).unwrap();
        image.reserved_fee = U128(reserved);
        image.recovery_witness = Some(receipt.clone());
        let mut next = history.clone();
        next.push(image.clone());
        self.nonces.insert(
            format!("custody-recovery:{}:{}", receipt.event, receipt.nonce),
            format!(
                "{}:{}",
                custody::record_hash(&receipt),
                custody::image_hash(&image)
            ),
        );
        self.custody_history.insert(receipt.event.clone(), next);
        self.custody_images.insert(receipt.event, image.clone());
        image
    }
}
