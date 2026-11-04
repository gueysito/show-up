//! Local G1 receipt binding. Engineering/mainnet routing remains unavailable.
use crate::financial::{money, text};
use crate::*;
use near_sdk::NearToken;
use near_sdk::serde_json::{Value, json};

pub(crate) fn asset<'a>(policy: &'a RoutingPolicy, network: &str) -> &'a FundingAsset {
    policy
        .assets
        .iter()
        .find(|asset| asset.network == network)
        .expect("Unapproved funding network")
}
pub(crate) fn validate_policy(
    policy: &RoutingPolicy,
    token: &AccountId,
    credential: &[u8; 32],
    evidence: &[u8; 32],
) {
    require!(
        policy.assets.len() == 4,
        "All four funding identities required"
    );
    require!(
        policy.quote_key.0.len() == 32
            && policy.quote_key.0 != credential
            && policy.quote_key.0 != evidence,
        "Separate routing quote key required"
    );
    for network in ["near", "base", "ethereum", "solana"] {
        require!(
            policy
                .assets
                .iter()
                .filter(|asset| asset.network == network)
                .count()
                == 1,
            "Duplicate or missing funding identity"
        );
        let selected = asset(policy, network);
        require!(
            !selected.contract.is_empty()
                && selected.contract.len() <= 128
                && !selected.route_asset.is_empty()
                && selected.route_asset.len() <= 160
                && !selected.chain_id.is_empty()
                && selected.chain_id.len() <= 64,
            "Funding identity bounds"
        );
        if network == "near" {
            require!(
                selected.contract == token.as_str() && selected.chain_id == "sandbox",
                "Wrong local settlement identity"
            );
        }
    }
}
fn timestamp(value: &Value) -> u64 {
    chrono::DateTime::parse_from_rfc3339(text(value))
        .expect("Invalid routing time")
        .timestamp_millis()
        .try_into()
        .expect("Routing timestamp bounds")
}
pub(crate) fn message(registration: &str) -> String {
    String::from_utf8(canonical::bytes(
        &json!({"kind":"routed_commitment","registration":registration}),
    ))
    .unwrap()
}
fn authorization_hash(auth: &Authorization) -> String {
    env::sha256(canonical::bytes(auth))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[near]
impl Escrow {
    #[payable]
    pub fn reserve_routed(
        &mut self,
        authorization: Authorization,
        proof: Base64VecU8,
        quote: String,
    ) -> String {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Exactly one yocto required"
        );
        let event = self
            .events
            .get(&authorization.event)
            .expect("Unknown event");
        let policy = event
            .terms
            .routing_policy
            .as_ref()
            .expect("Routed policy missing")
            .clone();
        require!(
            self.domain == "showup.sandbox.authorization.v1",
            "Routed funding remains local sandbox only"
        );
        let consent = self
            .check_authorization_for_route(&authorization, &proof, true)
            .expect("Routed financial consent required");
        if authorization.source.network == "near" {
            let key = env::signer_account_pk();
            require!(
                env::predecessor_account_id().as_str() == authorization.source.address
                    && env::signer_account_id().as_str() == authorization.source.address
                    && key.as_bytes().len() == 33
                    && key.as_bytes()[0] == 0
                    && Some(key.as_bytes()[1..].try_into().unwrap()) == consent.public_key,
                "Native routed consent requires its actual source signer"
            );
        }
        let key: [u8; 32] = policy.quote_key.0.clone().try_into().unwrap();
        let (parsed, selected, quote_hash) = routing_quote::authenticate(&quote, &key);
        let request = parsed["quoteRequest"].as_object().unwrap();
        let fields = &selected.fields;
        let source = asset(&policy, &authorization.source.network);
        require!(
            request["dry"] == false
                && fields["swapType"] == "EXACT_OUTPUT"
                && fields["slippageTolerance"] == 100
                && fields["depositType"] == "ORIGIN_CHAIN"
                && fields["refundType"] == "ORIGIN_CHAIN"
                && fields["recipientType"] == "DESTINATION_CHAIN"
                && fields["originAsset"] == source.route_asset
                && fields["destinationAsset"] == format!("nep141:{}", self.token)
                && fields["recipient"] == env::current_account_id().as_str()
                && fields["refundTo"] == authorization.refund.address
                && fields["customRecipientMsg"] == message(&authorization.registration),
            "Routing request differs from its original authorization"
        );
        require!(
            !request.contains_key("virtualChainRecipient")
                && !request.contains_key("virtualChainRefundRecipient")
                && !request.contains_key("referral")
                && !request.get("insured").is_some_and(|v| v != &json!(false))
                && !request.get("depositMode").is_some_and(|v| v != "SIMPLE"),
            "Unsupported routing modifier"
        );
        let input = money(&fields["amountIn"]);
        let minimum_input = money(&fields["minAmountIn"]);
        let principal = authorization.principal.0;
        require!(
            money(&fields["amount"]) == principal
                && money(&fields["amountOut"]) == principal
                && money(&fields["minAmountOut"]) == principal
                && minimum_input > 0
                && minimum_input <= input
                && input >= principal
                && input <= consent.maximum_input
                && input - principal <= consent.routing_fee_maximum
                && quote_hash == consent.quote_hash,
            "Routing amounts or signed quote binding changed"
        );
        let deadline = timestamp(&fields["deadline"]);
        let created = timestamp(&fields["timestamp"]);
        require!(
            timestamp(&selected.request_deadline) == consent.quote_expires_ms
                && deadline <= consent.quote_expires_ms
                && deadline > now()
                && created <= consent.issued_ms
                && created.saturating_add(60_000) >= consent.issued_ms,
            "Routing quote is stale or its deadline changed"
        );
        let deposit = text(&fields["depositAddress"]);
        require!(
            !deposit.is_empty() && deposit.len() <= 128 && !fields.contains_key("depositMemo"),
            "Unsupported routing deposit destination"
        );
        let binding = RoutedFunding {
            authorization_hash: authorization_hash(&authorization),
            provider: policy.sender,
            quote_hash,
            deposit_address: deposit.into(),
            quote_deadline_ms: deadline,
        };
        if let Some(old) = self.routed_funding.get(&authorization.registration) {
            require!(old == &binding, "Routed quote binding cannot change");
        }
        let registration = authorization.registration.clone();
        let state = self.reserve_checked(authorization);
        self.routed_funding.insert(registration, binding);
        state
    }

    pub fn get_routed_funding(&self, registration: String) -> Option<RoutedFunding> {
        self.routed_funding.get(&registration).cloned()
    }
}

impl Escrow {
    pub(crate) fn receive_routed(
        &mut self,
        registration: &String,
        amount: u128,
        sender: &AccountId,
    ) {
        let binding = self
            .routed_funding
            .get(registration)
            .expect("Unknown routed registration");
        require!(sender == &binding.provider, "Wrong routing token sender");
        let auth = self
            .registrations
            .get(registration)
            .expect("Stored routed authorization missing")
            .authorization
            .clone();
        require!(
            authorization_hash(&auth) == binding.authorization_hash,
            "Stored routed authorization changed"
        );
        // Signature, source control, rules and quote were fixed at reservation.
        // A late/short/duplicate receipt creates debt to the original refund
        // destination; it never acquires fresh authority or extends a window.
        self.apply_funding_receipt(auth, amount);
    }
}
