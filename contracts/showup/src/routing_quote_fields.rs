//! The provider SDK's selected-field protocol. No cryptographic or payment claim.
use serde_json::{Map, Value};

const REQUEST: &[&str] = &[
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
];
const OPTIONAL_REQUEST: &[&str] = &[
    "quoteWaitingTimeMs",
    "referral",
    "virtualChainRecipient",
    "virtualChainRefundRecipient",
    "customRecipientMsg",
];
const AMOUNTS: &[&str] = &[
    "amountIn",
    "amountInFormatted",
    "amountInUsd",
    "minAmountIn",
    "amountOut",
    "amountOutFormatted",
    "amountOutUsd",
    "minAmountOut",
];
const WET: &[&str] = &[
    "depositAddress",
    "depositMemo",
    "deadline",
    "timeWhenInactive",
    "timeEstimate",
    "refundFee",
    "withdrawFee",
];
pub(crate) struct SelectedQuote {
    pub fields: Map<String, Value>,
    pub request_deadline: Value,
    pub request_deadline_authenticated: bool,
}
fn scalar(value: &Value) {
    assert!(
        matches!(value, Value::String(_) | Value::Bool(_) | Value::Number(_))
            && value.as_str().is_none_or(|text| text.len() <= 16_384),
        "Invalid provider signed scalar"
    );
    if let Value::Number(number) = value {
        assert!(
            number.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991),
            "Provider number must be an exact nonnegative integer"
        );
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_u64() != Some(0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn selected(
    fields: &mut Map<String, Value>,
    object: &Map<String, Value>,
    names: &[&str],
    optional: bool,
) {
    for name in names {
        if let Some(value) = object.get(*name) {
            if optional && !truthy(value) {
                continue;
            }
            scalar(value);
            fields.insert((*name).into(), value.clone());
        } else {
            assert!(optional, "Missing provider signed field");
        }
    }
}
pub(crate) fn quote_fields(parsed: &Value) -> SelectedQuote {
    let request = parsed["quoteRequest"]
        .as_object()
        .expect("Provider request required");
    let quote = parsed["quote"]
        .as_object()
        .expect("Provider quote required");
    let dry = request["dry"]
        .as_bool()
        .expect("Provider quote mode required");
    let mut fields = Map::new();
    selected(&mut fields, request, REQUEST, false);
    selected(&mut fields, request, OPTIONAL_REQUEST, true);
    selected(&mut fields, quote, AMOUNTS, false);
    if !dry {
        selected(&mut fields, quote, WET, true);
    }
    let timestamp = parsed
        .get("timestamp")
        .expect("Provider timestamp required");
    scalar(timestamp);
    assert!(timestamp.is_string(), "Provider timestamp must be text");
    fields.insert("timestamp".into(), timestamp.clone());
    SelectedQuote {
        fields,
        request_deadline: request["deadline"].clone(),
        request_deadline_authenticated: dry || !quote.get("deadline").is_some_and(truthy),
    }
}
