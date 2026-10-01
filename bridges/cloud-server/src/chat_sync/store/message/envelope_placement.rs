//! Where routing envelopes may appear in message content.
//!
//! Clients join the text of every block before decoding an envelope, while
//! the server reads the first text block. An envelope is therefore accepted
//! only in canonical position: the exact start of a first block of type
//! `text`, with no text in any later block. Content in that shape reads the
//! same way on every client and on the server.

use serde_json::{json, Value};

use super::super::StoreError;

pub(in crate::chat_sync::store) const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
pub(in crate::chat_sync::store) const CLOUD_DIRECT_PREFIX: &str = "kordi-cloud-message:";
pub(in crate::chat_sync::store) const CLOUD_AGENT_RESPONSE_PREFIX: &str =
    "kordi-cloud-agent-response:";
pub(super) const RESERVED_ENVELOPE_PREFIXES: [&str; 3] = [
    CLOUD_GROUP_PREFIX,
    CLOUD_DIRECT_PREFIX,
    CLOUD_AGENT_RESPONSE_PREFIX,
];
pub(super) const INVALID_GROUP_ENVELOPE: &str = "group message envelope is invalid";
const INVALID_ENVELOPE: &str = "message envelope is invalid";
const RESERVED_PREFIX: &str = "message text uses a reserved prefix";

/// The text of every block that carries one, in the order clients join them.
fn block_texts(content: &Value) -> Vec<&str> {
    content
        .get("blocks")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

fn leading_reserved_prefix(text: &str) -> Option<&'static str> {
    let text = text.trim_start();
    RESERVED_ENVELOPE_PREFIXES
        .into_iter()
        .find(|prefix| text.starts_with(prefix))
}

/// The envelope prefix that any reader could find in this content: at the
/// start of the joined block text or of any single block's text.
fn visible_envelope_prefix(content: &Value) -> Option<&'static str> {
    let texts = block_texts(content);
    leading_reserved_prefix(&texts.concat())
        .or_else(|| texts.into_iter().find_map(leading_reserved_prefix))
}

/// The prefix of an envelope stored in canonical position.
pub(super) fn canonical_envelope_prefix(content: &Value) -> Option<&'static str> {
    let (first, rest) = content.get("blocks")?.as_array()?.split_first()?;
    if first.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    let text = first.get("text")?.as_str()?;
    let prefix = RESERVED_ENVELOPE_PREFIXES
        .into_iter()
        .find(|prefix| text.starts_with(prefix))?;
    rest.iter()
        .all(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
        .then_some(prefix)
}

/// Validates submitted content. Returns the prefix of an envelope in
/// canonical position and refuses an envelope anywhere else.
pub(super) fn validate_envelope_placement(
    content: &Value,
) -> Result<Option<&'static str>, StoreError> {
    let Some(visible) = visible_envelope_prefix(content) else {
        return Ok(None);
    };
    match canonical_envelope_prefix(content) {
        Some(prefix) if prefix == visible => Ok(Some(prefix)),
        _ if visible == CLOUD_GROUP_PREFIX => Err(StoreError::InvalidInput(INVALID_GROUP_ENVELOPE)),
        _ => Err(StoreError::InvalidInput(INVALID_ENVELOPE)),
    }
}

/// Validates content that the server rewrote from stored content, such as an
/// edit, a voice transcript, or an attachment removal. A rewrite may update an
/// envelope that was already in canonical position, but it must never create
/// an envelope or move one, because only message creation normalizes the
/// envelope's sender identity.
pub(crate) fn ensure_rewrite_keeps_envelope_placement(
    before: &Value,
    after: &Value,
) -> Result<(), StoreError> {
    let Some(visible) = visible_envelope_prefix(after) else {
        return Ok(());
    };
    if canonical_envelope_prefix(after) == Some(visible)
        && canonical_envelope_prefix(before) == Some(visible)
    {
        Ok(())
    } else {
        Err(StoreError::InvalidInput(RESERVED_PREFIX))
    }
}

/// Moves an envelope that clients would decode from the joined block text
/// into canonical position, so the server reads, and repairs, the same
/// envelope that clients render. Only content stored before envelope
/// placement was validated can need this.
pub(super) fn canonicalize_envelope_placement(content: &mut Value) {
    let joined = block_texts(content).concat();
    if !RESERVED_ENVELOPE_PREFIXES
        .iter()
        .any(|prefix| joined.starts_with(prefix))
        || canonical_envelope_prefix(content).is_some()
    {
        return;
    }
    let Some(blocks) = content.get_mut("blocks").and_then(Value::as_array_mut) else {
        return;
    };
    for block in blocks.iter_mut() {
        if let Some(block) = block.as_object_mut() {
            block.remove("text");
        }
    }
    blocks.insert(0, json!({ "type": "text", "text": joined }));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENVELOPE: &str = "kordi-cloud-group:eyJraW5kIjoiZ3JvdXAtbWVzc2FnZSJ9";

    fn text_blocks(texts: &[&str]) -> Value {
        json!({ "blocks": texts
            .iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect::<Vec<_>>() })
    }

    #[test]
    fn submitted_envelopes_are_accepted_only_in_canonical_position() {
        assert_eq!(
            validate_envelope_placement(&text_blocks(&["hello"])).unwrap(),
            None
        );
        assert_eq!(
            validate_envelope_placement(&text_blocks(&[ENVELOPE])).unwrap(),
            Some(CLOUD_GROUP_PREFIX)
        );
        assert_eq!(
            validate_envelope_placement(&json!({ "blocks": [
                { "type": "text", "text": ENVELOPE },
                { "type": "voice", "mediaId": "audio" }
            ] }))
            .unwrap(),
            Some(CLOUD_GROUP_PREFIX)
        );
        for prefix in RESERVED_ENVELOPE_PREFIXES {
            for rejected in [
                text_blocks(&["", &format!("{prefix}e30")]),
                text_blocks(&[&format!(" {prefix}e30")]),
                text_blocks(&[&format!("{prefix}e30"), "tail"]),
                json!({ "blocks": [{ "type": "image", "text": format!("{prefix}e30") }] }),
            ] {
                assert!(
                    validate_envelope_placement(&rejected).is_err(),
                    "{rejected}"
                );
            }
        }
    }

    #[test]
    fn rewrites_cannot_complete_an_envelope_from_several_blocks() {
        let before = text_blocks(&["hello", "group:e30"]);
        assert_eq!(validate_envelope_placement(&before).unwrap(), None);
        let after = text_blocks(&["kordi-cloud-", "group:e30"]);
        assert!(matches!(
            ensure_rewrite_keeps_envelope_placement(&before, &after),
            Err(StoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn rewrites_cannot_turn_plain_text_into_an_envelope() {
        let before = json!({ "blocks": [
            { "type": "text", "text": "" },
            { "type": "voice", "mediaId": "audio" }
        ] });
        let mut after = before.clone();
        after["blocks"][0]["text"] = json!(ENVELOPE);
        assert!(ensure_rewrite_keeps_envelope_placement(&before, &after).is_err());
        after["blocks"][0]["text"] = json!("Meet at noon, kordi-cloud-group: later");
        assert!(ensure_rewrite_keeps_envelope_placement(&before, &after).is_ok());
    }

    #[test]
    fn rewrites_keep_existing_canonical_envelopes() {
        let before = text_blocks(&[ENVELOPE]);
        let after = text_blocks(&["kordi-cloud-group:eyJraW5kIjoiZ3JvdXAifQ"]);
        assert!(ensure_rewrite_keeps_envelope_placement(&before, &after).is_ok());
        let direct = text_blocks(&["kordi-cloud-message:e30"]);
        assert!(ensure_rewrite_keeps_envelope_placement(&before, &direct).is_err());
        let moved = text_blocks(&["", ENVELOPE]);
        assert!(ensure_rewrite_keeps_envelope_placement(&before, &moved).is_err());
    }

    #[test]
    fn stored_envelopes_split_across_blocks_move_into_canonical_position() {
        let (head, tail) = ENVELOPE.split_at(12);
        let mut content = json!({ "blocks": [
            { "type": "text", "text": head },
            { "type": "image", "attachmentId": "photo", "text": "" },
            { "type": "text", "text": tail }
        ] });
        canonicalize_envelope_placement(&mut content);
        assert_eq!(
            canonical_envelope_prefix(&content),
            Some(CLOUD_GROUP_PREFIX)
        );
        assert_eq!(block_texts(&content).concat(), ENVELOPE);
        assert_eq!(content["blocks"][2]["attachmentId"], "photo");

        let mut plain = text_blocks(&["hello", "world"]);
        let original = plain.clone();
        canonicalize_envelope_placement(&mut plain);
        assert_eq!(plain, original);
    }
}
