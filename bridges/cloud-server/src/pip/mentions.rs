//! `@Handle` mentions in PiP's messages.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

/// PiP's text in the cloud message envelope the clients decode, with the
/// mentions they render and notify on.
pub(crate) fn encode_pip_message_with_mentions(text: &str, mentions: Vec<Value>) -> String {
    let payload =
        json!({"schemaVersion": 1, "kind": "message", "text": text, "mentions": mentions});
    format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    )
}

/// `@Handle` for a member: the display name without spaces, which is what the
/// clients' mention parsers match a token against.
pub(crate) fn mention_handle(display_name: &str) -> String {
    display_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Resolves `@Handle` tokens in PiP's text to member mentions in the shape
/// the clients render and notify on. Unknown handles stay plain text.
pub(crate) fn resolve_mentions(text: &str, members: &[(String, String)]) -> Vec<Value> {
    let mut mentions = Vec::new();
    let mut utf16_offset = 0usize;
    let mut chars = text.chars().peekable();
    let mut previous: Option<char> = None;
    while let Some(c) = chars.next() {
        if c == '@' && previous.is_none_or(|p| !p.is_alphanumeric()) {
            let start_utf16 = utf16_offset;
            let mut handle = String::new();
            let mut token_utf16 = c.len_utf16();
            while let Some(next) = chars.peek().copied().filter(|next| next.is_alphanumeric()) {
                handle.push(next);
                token_utf16 += next.len_utf16();
                chars.next();
            }
            utf16_offset += token_utf16;
            previous = handle.chars().last().or(Some(c));
            if handle.is_empty() {
                continue;
            }
            let matched: Vec<&(String, String)> = members
                .iter()
                .filter(|(_, display_name)| {
                    mention_handle(display_name).eq_ignore_ascii_case(&handle)
                })
                .collect();
            // An ambiguous handle must never pick a member by position.
            if let [(account_id, display_name)] = matched.as_slice() {
                mentions.push(json!({
                    "label": mention_handle(display_name),
                    "targetKind": "person",
                    "targetIdentityId": account_id,
                    "humanId": account_id,
                    "displayText": format!("@{handle}"),
                    "displayLabel": display_name,
                    "startUtf16": start_utf16,
                    "lengthUtf16": token_utf16,
                }));
            }
            continue;
        }
        utf16_offset += c.len_utf16();
        previous = Some(c);
    }
    mentions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_resolve_to_one_member_with_utf16_offsets() {
        let members = vec![
            ("acct_mina".to_string(), "Mina Park".to_string()),
            ("acct_theo".to_string(), "Theo".to_string()),
            ("acct_theo2".to_string(), "Theo".to_string()),
        ];
        let mentions = resolve_mentions("\u{1f44b} @MinaPark and @theo, email a@b", &members);
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["targetIdentityId"], "acct_mina");
        assert_eq!(mentions[0]["startUtf16"], 3);
        assert_eq!(mentions[0]["lengthUtf16"], 9);
    }
}
