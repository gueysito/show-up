//! Explicit native non-production financial consent. No external funding route.
use crate::*;
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD};
use near_sdk::serde_json::{Map, Value, json};

pub(crate) struct FundingConsent {
    pub public_key: [u8; 32],
    pub maximum_input: u128,
}

pub(crate) fn valid_origin(value: &str) -> bool {
    value.len() <= 263
        && value.strip_prefix("https://").is_some_and(|host| {
            !host.is_empty()
                && host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
        })
}
fn object<'a>(value: &'a Value, fields: &str) -> &'a Map<String, Value> {
    let parsed = value
        .as_object()
        .expect("Financial consent object required");
    let mut keys: Vec<_> = parsed.keys().map(String::as_str).collect();
    keys.sort_unstable();
    require!(
        keys.join(",") == fields,
        "Unexpected financial consent fields"
    );
    parsed
}
fn text(value: &Value) -> &str {
    value.as_str().expect("Financial consent text required")
}
fn number(value: &Value) -> u64 {
    let result = value.as_u64().expect("Financial consent integer required");
    require!(
        result <= 9_007_199_254_740_991,
        "Unsafe financial consent integer"
    );
    result
}
fn money(value: &Value) -> u128 {
    let value = text(value);
    require!(
        !value.is_empty()
            && value.len() <= 39
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Noncanonical financial amount"
    );
    value.parse().expect("Financial amount overflow")
}
fn hash(value: &Value) -> String {
    env::sha256(canonical::bytes(value))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn reference(value: &Value) -> String {
    let value = text(value);
    require!(
        value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                }
            }),
        "Invalid financial event credential"
    );
    format!("{:0>64}", value.replace('-', ""))
}
fn iso(value: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        value.try_into().expect("Financial time overflow"),
    )
    .expect("Financial time range")
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn base64<const N: usize>(value: &Value) -> [u8; N] {
    let encoded = text(value);
    let bytes = STANDARD.decode(encoded).expect("Invalid financial base64");
    require!(
        STANDARD.encode(&bytes) == encoded,
        "Noncanonical financial base64"
    );
    bytes.try_into().expect("Financial byte length")
}
fn wallet(value: &Value, expected: &Destination, token: &AccountId, chain_id: &str) {
    let value = object(value, "address,chainId,network");
    require!(
        text(&value["network"]) == "near"
            && text(&value["chainId"]) == chain_id
            && expected.network == "near"
            && expected.asset == token.as_str()
            && text(&value["address"]) == expected.address,
        "Native financial destination changed or external route unqualified"
    );
}

impl Escrow {
    pub(crate) fn check_financial_consent(&self, auth: &Authorization) -> Option<FundingConsent> {
        let (environment, chain_id, warning) = if self.domain
            == "showup.engineering.authorization.v1"
        {
            (
                "engineering",
                "testnet",
                "ENGINEERING TEST TOKENS ONLY. No mainnet funds or qualified funding route is authorized.",
            )
        } else {
            (
                "sandbox",
                "sandbox",
                "DISPOSABLE SANDBOX TOKENS ONLY. No real USDC or live funding route is authorized.",
            )
        };
        let event = self.events.get(&auth.event).expect("Unknown event");
        let Some(origin) = &event.terms.wallet_consent_origin else {
            require!(
                auth.wallet_consent.is_none(),
                "Financial policy is not enabled for this prototype event"
            );
            return None;
        };
        let encoded = auth
            .wallet_consent
            .as_ref()
            .expect("Source wallet financial consent required");
        require!(encoded.len() <= 12288, "Financial envelope bounds");
        let envelope: Value =
            near_sdk::serde_json::from_str(encoded).expect("Invalid financial envelope");
        require!(
            encoded.as_bytes() == canonical::bytes(&envelope),
            "Noncanonical financial envelope"
        );
        let envelope = object(&envelope, "acceptedAt,consent,proof");
        let consent = object(
            &envelope["consent"],
            "format,id,issuedAt,message,nonce,origin,signingExpiresAt,terms,termsHash",
        );
        require!(
            text(&consent["format"]) == "showup.commitment.consent.v1"
                && text(&consent["origin"]) == origin,
            "Wrong financial consent purpose or origin"
        );
        let _ = reference(&consent["id"]);
        let terms = object(
            &consent["terms"],
            "authorizationExpiresAt,deployment,environment,event,inputAsset,manifest,maximumInput,participant,payout,payoutMinimum,principal,quoteExpiresAt,quoteHash,refund,registration,registrationClosesAt,reservationExpiresAt,routingFeeMaximum,rulesHash,source,sourceGasMaximum,timeZone,withdrawalFeeMaximum",
        );
        require!(
            text(&terms["environment"]) == environment
                && text(&terms["manifest"]) == self.manifest
                && text(&terms["deployment"]) == env::current_account_id().as_str()
                && reference(&terms["event"]) == auth.event
                && text(&terms["rulesHash"]) == auth.rules_hash
                && reference(&terms["registration"]) == auth.registration
                && reference(&terms["participant"]) == auth.participant,
            "Financial deployment or registration binding changed"
        );
        wallet(&terms["source"], &auth.source, &self.token, chain_id);
        wallet(&terms["refund"], &auth.refund, &self.token, chain_id);
        wallet(&terms["payout"], &auth.payout, &self.token, chain_id);
        let input = object(&terms["inputAsset"], "contract,decimals");
        require!(
            text(&input["contract"]) == self.token.as_str() && number(&input["decimals"]) == 6,
            "Wrong financial settlement asset"
        );
        let principal = money(&terms["principal"]);
        let maximum_input = money(&terms["maximumInput"]);
        let fee = money(&terms["withdrawalFeeMaximum"]);
        let minimum = money(&terms["payoutMinimum"]);
        require!(
            principal == auth.principal.0
                && principal >= 2_500_000
                && maximum_input >= principal
                && fee == auth.fee_cap.0
                && fee < principal
                && minimum > 0
                && principal - fee >= minimum,
            "Financial principal or fee limits changed"
        );
        let _ = money(&terms["sourceGasMaximum"]);
        let _ = money(&terms["routingFeeMaximum"]);
        require!(
            valid_id(text(&terms["quoteHash"])),
            "Invalid financial quote binding"
        );
        let timezone = text(&terms["timeZone"]);
        require!(
            !timezone.is_empty()
                && timezone.len() <= 100
                && timezone
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/_.+-".contains(&byte)),
            "Invalid financial timezone metadata"
        );
        let issued = number(&consent["issuedAt"]);
        let signing = number(&consent["signingExpiresAt"]);
        let accepted = number(&envelope["acceptedAt"]);
        let expires = number(&terms["authorizationExpiresAt"]);
        let reservation = number(&terms["reservationExpiresAt"]);
        let close = number(&terms["registrationClosesAt"]);
        let quote_expires = number(&terms["quoteExpiresAt"]);
        require!(
            expires > issued
                && expires <= issued.saturating_add(1_800_000)
                && expires <= close.min(quote_expires)
                && close == event.terms.start_ms
                && reservation == issued.saturating_add(300_000).min(close).min(expires)
                && signing == issued.saturating_add(300_000).min(expires)
                && accepted >= issued
                && accepted < signing
                && accepted <= now()
                && expires == auth.expires_ms
                && reservation == auth.reservation_ms,
            "Financial consent deadlines changed"
        );
        require!(
            auth.wallet_tag
                == hash(&json!({"format":"showup.funding.wallet.v1",
            "deployment":auth.deployment,"environment":environment,"manifest":self.manifest,
            "event":auth.event,"family":"near","address":auth.source.address})),
            "Financial wallet tag changed"
        );
        require!(
            auth.nonce
                == hash(&json!({"format":"showup.commitment.nonce.v1",
            "id":consent["id"],"nonce":consent["nonce"]})),
            "Financial nonce changed"
        );
        let terms_hash = hash(&consent["terms"]);
        require!(
            text(&consent["termsHash"]) == terms_hash,
            "Financial terms hash changed"
        );
        let terms_json = String::from_utf8(canonical::bytes(&consent["terms"])).unwrap();
        let message = [
            "Showup event financial consent v1".to_string(),
            warning.into(),
            format!("Website: {origin}"),
            "Authorize only the event and limits below. A separate wallet transaction is required to transfer funds.".into(),
            "A signature, quote or reservation creates no funded seat. Enrollment requires actual attributable escrow.".into(),
            "Principal and payout limits use USDC atomic units (1 USDC = 1000000).".into(),
            "Maximum input uses the selected input asset units. Source gas maximum uses native atomic units.".into(),
            "Routing and withdrawal fee maxima use USDC atomic units. The platform fee is zero.".into(),
            "Principal returns less disclosed, authorized delivery fees. Unresolved amounts remain recoverable.".into(),
            format!("Consent: {}",text(&consent["id"])), format!("Nonce: {}",text(&consent["nonce"])),
            format!("Issued: {}",iso(issued)),format!("Sign before: {}",iso(signing)),
            format!("Terms SHA-256: {terms_hash}"), terms_json,
        ].join("\n");
        require!(
            message.len() <= 8192 && text(&consent["message"]) == message,
            "Financial wallet message changed"
        );
        let proof = object(&envelope["proof"], "accountId,publicKey,signature");
        require!(
            text(&proof["accountId"]) == auth.source.address,
            "Financial signer account changed"
        );
        let public_key = text(&proof["publicKey"])
            .strip_prefix("ed25519:")
            .expect("Financial Ed25519 key required");
        let bytes = bs58::decode(public_key)
            .into_vec()
            .expect("Invalid financial public key");
        require!(
            bs58::encode(&bytes).into_string() == public_key,
            "Noncanonical financial public key"
        );
        let public_key: [u8; 32] = bytes.try_into().expect("Financial public key length");
        let signature = base64::<64>(&proof["signature"]);
        let nonce = base64::<32>(&consent["nonce"]);
        let recipient = origin.strip_prefix("https://").unwrap();
        let callback = format!(
            "{origin}/account/commitments?consent={}",
            text(&consent["id"])
        );
        let payload = near_sdk::borsh::to_vec(&(
            2_u32.pow(31) + 413,
            message,
            nonce,
            recipient,
            Some(callback),
        ))
        .unwrap();
        require!(
            env::ed25519_verify(&signature, env::sha256(payload), &public_key),
            "Invalid source financial signature"
        );
        Some(FundingConsent {
            public_key,
            maximum_input,
        })
    }
}
