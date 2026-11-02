use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Value};

/// Compact UTF-8 JSON with recursively sorted object keys. Signed schemas use
/// only integer timestamps, decimal amount strings and explicit domain fields.
/// Sorting here keeps the wire format independent of serde_json feature flags.
pub(crate) fn bytes<T: Serialize>(value: &T) -> Vec<u8> {
    let value = serde_json::to_value(value).expect("Signature serialization");
    let mut output = Vec::new();
    append(&value, &mut output);
    output
}

fn append(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Object(fields) => {
            output.push(b'{');
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).expect("JSON key");
                output.push(b':');
                append(&fields[key], output);
            }
            output.push(b'}');
        }
        Value::Array(items) => {
            output.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                append(item, output);
            }
            output.push(b']');
        }
        _ => serde_json::to_writer(output, value).expect("JSON scalar"),
    }
}
