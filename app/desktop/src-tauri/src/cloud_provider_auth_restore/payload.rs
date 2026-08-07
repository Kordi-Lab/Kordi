use serde_json::Value;

pub(super) fn required_string(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Cloud provider-auth restore field {key} is missing"))
}

pub(super) fn optional_string(payload: &serde_json::Map<String, Value>, key: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

pub(super) fn optional_value(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<String> {
    let value = optional_string(payload, key);
    (!value.is_empty()).then_some(value)
}

pub(super) fn required_i64(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<i64, String> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("Cloud provider-auth restore field {key} is missing"))
}
