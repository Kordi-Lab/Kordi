use super::*;

// Must match cloudOperationUuid in the desktop Cloud client. This only derives
// an operation identity from a local message ID; it is not a security hash.
pub(crate) fn cloud_request_client_message_id(session_id: &str, local_message_id: &str) -> String {
    let input = format!("self-agent:{session_id}:{local_message_id}:request");
    let mut seed = 0x811c9dc5_u32;
    for unit in input.encode_utf16() {
        seed = (seed ^ u32::from(unit)).wrapping_mul(0x01000193);
    }
    let mut state = seed;
    let mut bytes = [0_u8; 16];
    for byte in &mut bytes {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        *byte = state as u8;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub(super) fn exported_agent_intent_matches(
    conn: &Connection,
    local: &crate::canonical_sessions::CanonicalSessionMessage,
    cloud: &crate::canonical_sessions::CanonicalSessionMessage,
) -> Result<bool, String> {
    if local.content_text.trim() != cloud.content_text.trim() {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_sync_messages wire JOIN chat_sync_conversations conversation
         ON conversation.account_id=wire.account_id AND conversation.conversation_id=wire.conversation_id
         WHERE wire.message_id=?1 AND wire.message_kind='canonical-history-agent' AND conversation.client_session_id=?2
         AND COALESCE(json_extract(wire.snapshot_json,'$.content.canonical_history.local_message_id'),
                      json_extract(wire.snapshot_json,'$.content.canonical_history.localMessageId'))=?3)",
        params![cloud.source_event_id,local.session_id,local.id], |row|row.get(0),
    ).map_err(|error|error.to_string())
}
