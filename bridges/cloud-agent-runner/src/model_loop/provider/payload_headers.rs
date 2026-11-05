//! Extra request headers a provider payload may carry, such as a resource
//! pool gateway's attribution headers.

use std::collections::BTreeMap;

use serde_json::Value;

/// Headers a runner never takes from a payload: credentials, routing and
/// framing stay with the runner.
const RESERVED_HEADERS: [&str; 13] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "host",
    "content-type",
    "content-length",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "x-api-key",
    "api-key",
    "chatgpt-account-id",
];
const MAX_PAYLOAD_HEADERS: usize = 16;

/// The extra headers of a provider payload (`headers`, an object of
/// strings). Reserved, malformed and surplus entries are dropped.
pub(super) fn from_payload(payload: &Value) -> BTreeMap<String, String> {
    let Some(headers) = payload.get("headers").and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.trim().to_ascii_lowercase();
            let value = value.as_str()?.trim();
            let valid_name = !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                && !RESERVED_HEADERS.contains(&name.as_str());
            let valid_value = !value.is_empty()
                && value.len() <= 512
                && value.bytes().all(|b| b == b' ' || b.is_ascii_graphic());
            (valid_name && valid_value).then(|| (name, value.to_string()))
        })
        .take(MAX_PAYLOAD_HEADERS)
        .collect()
}
