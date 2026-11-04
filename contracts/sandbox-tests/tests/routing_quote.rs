mod common;
#[path = "../../showup/src/routing_quote_fields.rs"]
mod quote_fields;
use common::*;
use serde_json::{Value, json};

#[test]
fn wet_quote_selection_reports_overwritten_request_deadline_and_only_authenticates_selected_fields()
{
    let mut response: Value =
        serde_json::from_str(include_str!("../fixtures/one-click-return-dry-public.json")).unwrap();
    response["quoteRequest"]["dry"] = json!(false);
    response["quoteRequest"]["quoteWaitingTimeMs"] = json!(0);
    response["quote"]["depositAddress"] = json!("fixed-deposit.near");
    response["quote"]["deadline"] = json!("2026-11-05T00:00:00.000Z");
    let selected = quote_fields::quote_fields(&response);
    assert_eq!(selected.fields["deadline"], response["quote"]["deadline"]);
    assert_eq!(
        selected.request_deadline,
        response["quoteRequest"]["deadline"]
    );
    assert!(!selected.request_deadline_authenticated);
    assert!(!selected.fields.contains_key("quoteWaitingTimeMs"));
    assert_eq!(selected.fields["refundFee"], response["quote"]["refundFee"]);
    assert!(!selected.fields.contains_key("appFees"));
    std::fs::write(
        "/cache/routing-quote-wet-fields-public.json",
        serde_json::to_vec_pretty(&json!({"response":response,"selected":selected.fields}))
            .unwrap(),
    )
    .unwrap();
    response["quoteRequest"]["deadline"] = json!("2099-01-01T00:00:00Z");
    assert_eq!(
        quote_fields::quote_fields(&response).fields,
        selected.fields
    );
    for field in ["depositAddress", "refundFee", "withdrawFee", "deadline"] {
        let mut changed = response.clone();
        changed["quote"][field] = json!("substituted");
        assert_ne!(quote_fields::quote_fields(&changed).fields, selected.fields);
    }
}

#[tokio::test]
async fn routing_quote_inspection_matches_actual_provider_signature_without_financial_authority() {
    let f = Fixture::new(1, "online", 0).await;
    let response: Value =
        serde_json::from_str(include_str!("../fixtures/one-click-return-dry-public.json")).unwrap();
    let inspect = |value: Value| {
        f.escrow
            .view("inspect_routing_quote")
            .args_json(json!({"response":value.to_string()}))
    };
    let before = f.view("accounting", json!({})).await;
    let actual: Value = inspect(response.clone()).await.unwrap().json().unwrap();
    assert_eq!(actual["selected"]["amountIn"], "2500000");
    assert_eq!(actual["selected"]["amountOut"], "2497265");
    assert_eq!(actual["selected"]["minAmountOut"], "2472292");
    assert_eq!(
        actual["selected"]["recipient"],
        response["quoteRequest"]["recipient"]
    );
    assert_eq!(actual["request_deadline_authenticated"], true);
    for field in [
        "funding_allowed",
        "freshness_checked",
        "expected_request_checked",
    ] {
        assert_eq!(actual[field], false);
    }
    assert!(actual["selected"].get("refundFee").is_none());
    assert!(actual["selected"].get("withdrawFee").is_none());
    assert!(actual["selected"].get("appFees").is_none());
    // These dry fields really are excluded by the provider signature. Do not
    // accidentally promote a successful authentication into fee authorization.
    let mut unsigned = response.clone();
    unsigned["quote"]["refundFee"] = json!("999999999");
    unsigned["quote"]["withdrawFee"] = json!("999999999");
    unsigned["quoteRequest"]["appFees"] = json!([{"recipient":"attacker.near","fee":9999}]);
    let unchanged: Value = inspect(unsigned).await.unwrap().json().unwrap();
    assert_eq!(actual, unchanged);
    for (parent, field) in [
        ("quoteRequest", "originAsset"),
        ("quoteRequest", "destinationAsset"),
        ("quoteRequest", "refundTo"),
        ("quoteRequest", "recipient"),
        ("quoteRequest", "amount"),
        ("quoteRequest", "deadline"),
        ("quote", "amountIn"),
        ("quote", "amountOut"),
        ("quote", "minAmountOut"),
    ] {
        let mut changed = response.clone();
        changed[parent][field] = json!("substituted");
        assert!(
            inspect(changed).await.is_err(),
            "Accepted altered {parent}.{field}"
        );
    }
    let mut changed = response.clone();
    changed["quoteRequest"]["customRecipientMsg"] = json!("changed registration");
    assert!(inspect(changed).await.is_err());
    changed = response.clone();
    changed["timestamp"] = json!("2099-01-01T00:00:00Z");
    assert!(inspect(changed).await.is_err());
    assert_eq!(f.view("accounting", json!({})).await, before);
    std::fs::write(
        "/cache/routing-quote-public.json",
        serde_json::to_vec_pretty(&json!({
            "response":response, "inspection":actual
        }))
        .unwrap(),
    )
    .unwrap();
}
