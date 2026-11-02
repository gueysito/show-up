//! Local first-round proof boundary. This does not execute a provider, choose a
//! winner or allocate rewards. Original provider request allocation is a live gate.
use crate::*;
use near_sdk::serde_json::json;

#[near]
impl Escrow {
    /// Freeze once BEFORE original submission, including its overall deadline.
    /// Full-access fixture keys are NOT proof of production snapshot provenance.
    #[private]
    pub fn freeze_draw_proof(&mut self, event: String, snapshot_hash: String) -> DrawProof {
        require!(!self.draws.contains_key(&event), "Round already bound");
        let item = self.events.get(&event).expect("Unknown event");
        require!(
            item.status == "closed",
            "Freeze after complete reconciliation"
        );
        let policy = item
            .terms
            .draw_policy
            .as_ref()
            .expect("Draw policy missing");
        require!(
            env::signer_account_id() == policy.sender,
            "Wrong original sender"
        );
        require!(valid_id(&snapshot_hash), "Invalid snapshot");
        let context = json!({"domain":self.domain,"deployment":env::current_account_id(),
            "manifest":self.manifest,"event":event,"rules_hash":item.terms.rules_hash,
            "snapshot_hash":snapshot_hash,"round":0,"exclusion_hash":hex(&env::sha256(b"[]")),
            "provider":policy.provider,"project":policy.project,"version_hash":policy.version_hash,
            "sender":policy.sender,"key":policy.key});
        let seed = hex(&env::sha256(canonical::bytes(&context)));
        let created_ms = now();
        let proof = DrawProof {
            event: event.clone(),
            snapshot_hash,
            request_id: String::new(),
            seed,
            alpha: String::new(),
            created_ms,
            deadline_ms: created_ms.checked_add(120_000).expect("Invalid deadline"),
            attempts: 1,
            state: "awaiting_request".into(),
            output: None,
        };
        self.draws.insert(event, proof.clone());
        proof
    }

    /// Models original request allocation. No new execution or deadline reset.
    /// Provider provenance must still be proven before a real integration.
    #[private]
    pub fn bind_draw_proof(&mut self, event: String, request_id: String) -> DrawProof {
        require!(
            !request_id.is_empty()
                && request_id.len() <= 64
                && request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
            "Invalid original request ID"
        );
        let policy = self
            .events
            .get(&event)
            .expect("Unknown event")
            .terms
            .draw_policy
            .as_ref()
            .expect("Draw policy missing");
        require!(
            env::signer_account_id() == policy.sender,
            "Wrong original sender"
        );
        let proof = self.draws.get_mut(&event).expect("Freeze first");
        require!(
            proof.state == "awaiting_request" && now() < proof.deadline_ms,
            "Round already bound or expired"
        );
        proof.alpha = format!("vrf:{request_id}:{}:{}", policy.sender, proof.seed);
        proof.request_id = request_id;
        proof.state = "pending".into();
        proof.clone()
    }

    /// Retrieve/verify the SAME request; this method cannot request a new execution.
    pub fn recover_draw_proof(&mut self, event: String) -> DrawProof {
        let proof = self.draws.get_mut(&event).expect("Unknown round");
        require!(
            proof.state == "pending" && now() < proof.deadline_ms,
            "Round resolved or expired"
        );
        let due = match proof.attempts {
            1 => 15_000,
            2 => 45_000,
            _ => env::panic_str("Attempt limit"),
        };
        require!(now() >= proof.created_ms + due, "Recovery not due");
        proof.attempts += 1;
        proof.clone()
    }

    pub fn accept_draw_proof(
        &mut self,
        event: String,
        alpha: String,
        signature: Base64VecU8,
        output: String,
    ) -> DrawProof {
        let proof = self.draws.get(&event).expect("Unknown round");
        require!(
            proof.state == "pending" || proof.state == "verified",
            "Round timed out"
        );
        require!(
            alpha == proof.alpha && valid_id(&output),
            "Wrong request binding"
        );
        let policy = self
            .events
            .get(&event)
            .unwrap()
            .terms
            .draw_policy
            .as_ref()
            .unwrap();
        let key: [u8; 32] = policy.key.0.clone().try_into().expect("Draw key length");
        let signature: [u8; 64] = signature.0.try_into().expect("Proof length");
        require!(
            env::ed25519_verify(&signature, alpha.as_bytes(), &key),
            "Invalid draw signature"
        );
        require!(
            hex(&env::sha256(signature)) == output,
            "Wrong output derivation"
        );
        if proof.state == "verified" {
            require!(proof.output.as_ref() == Some(&output), "Conflicting result");
            return proof.clone();
        }
        require!(now() < proof.deadline_ms, "Proof deadline passed");
        let proof = self.draws.get_mut(&event).unwrap();
        proof.state = "verified".into();
        proof.output = Some(output);
        proof.clone()
    }

    pub fn timeout_draw_proof(&mut self, event: String) -> DrawProof {
        let proof = self.draws.get_mut(&event).expect("Unknown round");
        if proof.state != "pending" && proof.state != "awaiting_request" {
            return proof.clone();
        }
        require!(now() >= proof.deadline_ms, "Proof deadline pending");
        proof.state = "timed_out".into();
        proof.clone()
    }

    pub fn get_draw_proof(&self, event: String) -> Option<DrawProof> {
        self.draws.get(&event).cloned()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
