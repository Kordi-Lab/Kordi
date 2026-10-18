//! Keeps the owner's local file paths out of agent replies that other people
//! read (issue 1808).
//!
//! An agent that runs on the owner's Mac may answer with absolute paths such
//! as `/Users/<name>/Documents/plan.md`. In a group, or in a direct chat with
//! another person, every member would see the owner's home directory and
//! file layout. Before such a reply is stored, every local path in its text
//! becomes the bare file name, and a Markdown link whose target is a local
//! path becomes its label. Replies in the owner's own chat with their agent
//! keep their text.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

const GROUP_PREFIX: &str = "kordi-cloud-group:";
const AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

/// Starts of absolute paths that live on a person's own machine.
const LOCAL_PATH_STARTS: [&str; 9] = [
    "file://",
    "/Users/",
    "/home/",
    "/root/",
    "~/",
    "/private/var/",
    "/private/tmp/",
    "/var/folders/",
    "/Volumes/",
];

/// Characters that end a bare path. Paths with spaces are cut at the space;
/// the part that names the owner's directories is gone either way.
fn ends_path(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ')' | ']' | '>' | '<' | '`' | '"' | '\'' | '|' | '*')
}

/// A path may start only where it is not the tail of a word or of a URL.
fn starts_path_after(previous: Option<char>) -> bool {
    previous.is_none_or(|ch| !(ch.is_alphanumeric() || matches!(ch, '/' | '.' | '-' | '_' | '~')))
}

fn windows_user_path(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    bytes.len() > 9
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && rest
            .get(3..8)
            .is_some_and(|name| name.eq_ignore_ascii_case("users"))
        && (bytes[8] == b'\\' || bytes[8] == b'/')
}

fn is_local_path_start(rest: &str) -> bool {
    LOCAL_PATH_STARTS
        .iter()
        .any(|start| rest.starts_with(start))
        || windows_user_path(rest)
}

/// Whether `target` (a Markdown link destination) names a local file.
pub(crate) fn is_local_path(target: &str) -> bool {
    let target = target.trim().trim_start_matches('<');
    is_local_path_start(target)
}

/// The file or folder name at the end of `path`, without the folders above it.
pub(crate) fn file_name(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
}

/// The end of the Markdown link that starts at `start` (an `[`), with its
/// label and destination, or `None` when the text there is not a link.
fn markdown_link(text: &str, start: usize) -> Option<(usize, &str, &str)> {
    let rest = &text[start..];
    let mut depth = 0usize;
    let mut label_end = None;
    for (index, ch) in rest.char_indices().skip(1) {
        match ch {
            '\n' => return None,
            '[' => depth += 1,
            ']' if depth == 0 => {
                label_end = Some(index);
                break;
            }
            ']' => depth -= 1,
            _ => {}
        }
    }
    let label_end = label_end?;
    let after = &rest[label_end + 1..];
    if !after.starts_with('(') {
        return None;
    }
    let mut depth = 0usize;
    for (index, ch) in after.char_indices().skip(1) {
        match ch {
            '\n' => return None,
            '(' => depth += 1,
            ')' if depth == 0 => {
                let destination = &after[1..index];
                let end = start + label_end + 1 + index + 1;
                return Some((end, &rest[1..label_end], destination));
            }
            ')' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// Replaces Markdown links to local files with their labels, keeping an
/// image's alt text the same way.
fn strip_local_links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find('[') {
        let start = cursor + offset;
        let Some((end, label, destination)) = markdown_link(text, start) else {
            out.push_str(&text[cursor..=start]);
            cursor = start + 1;
            continue;
        };
        let target = destination.split_whitespace().next().unwrap_or_default();
        if !is_local_path(target) {
            out.push_str(&text[cursor..end]);
            cursor = end;
            continue;
        }
        let image = start > 0 && text[..start].ends_with('!');
        out.push_str(&text[cursor..start - usize::from(image)]);
        out.push_str(if label.trim().is_empty() {
            file_name(target.trim_end_matches('>'))
        } else {
            label
        });
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// Replaces every bare local path with its file name.
fn strip_bare_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous = None;
    let mut index = 0usize;
    while index < text.len() {
        let rest = &text[index..];
        if starts_path_after(previous) && is_local_path_start(rest) {
            let length = rest.find(ends_path).unwrap_or(rest.len());
            let path = &rest[..length];
            let kept = path.trim_end_matches(['.', ',', ';', ':', '!', '?']);
            out.push_str(file_name(kept));
            out.push_str(&path[kept.len()..]);
            previous = path.chars().next_back();
            index += length;
            continue;
        }
        let ch = rest.chars().next().unwrap_or_default();
        out.push(ch);
        previous = Some(ch);
        index += ch.len_utf8();
    }
    out
}

/// `text` without local file paths: links to local files keep their labels
/// and bare paths keep their file names.
pub(crate) fn strip_local_paths(text: &str) -> String {
    if !text.contains(['/', '~', '\\']) {
        return text.to_string();
    }
    strip_bare_paths(&strip_local_links(text))
}

fn decode(encoded: &str) -> Option<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

fn encode(prefix: &str, value: &Value) -> Option<String> {
    Some(format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).ok()?)
    ))
}

/// Strips local paths from `object["text"]`; true when it changed.
fn strip_text_field(object: Option<&mut Value>) -> bool {
    let Some(text) = object.and_then(|value| value.get_mut("text")) else {
        return false;
    };
    let Some(current) = text.as_str() else {
        return false;
    };
    let stripped = strip_local_paths(current);
    if stripped == current {
        return false;
    }
    *text = Value::String(stripped);
    true
}

/// The body with local paths removed from an agent's reply: a group message
/// an agent sent, or a direct agent response when `direct` is true. `None`
/// when the body is something else or nothing changed.
pub(crate) fn stripped_agent_body(body: &str, direct: bool) -> Option<String> {
    if let Some(encoded) = body.strip_prefix(GROUP_PREFIX) {
        let mut envelope = decode(encoded)?;
        let message = envelope.get_mut("message")?;
        if message.get("senderKind").and_then(Value::as_str) != Some("agent") {
            return None;
        }
        return strip_text_field(Some(message)).then(|| encode(GROUP_PREFIX, &envelope))?;
    }
    let encoded = body
        .strip_prefix(AGENT_RESPONSE_PREFIX)
        .filter(|_| direct)?;
    let mut envelope = decode(encoded)?;
    if envelope.get("kind").and_then(Value::as_str) != Some("agent-response") {
        return None;
    }
    strip_text_field(Some(&mut envelope)).then(|| encode(AGENT_RESPONSE_PREFIX, &envelope))?
}

/// Rewrites a message about to be stored when it is an agent reply that
/// people other than the agent's owner read: any group message an agent
/// sent, and an agent response in a direct chat between two people.
pub(crate) async fn strip_shared_agent_reply(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    content: &mut Value,
) -> Result<(), sqlx_core::Error> {
    let Some(text) = content
        .get_mut("blocks")
        .and_then(|blocks| blocks.get_mut(0))
        .and_then(|block| block.get_mut("text"))
    else {
        return Ok(());
    };
    let Some(body) = text.as_str() else {
        return Ok(());
    };
    let direct = if body.starts_with(AGENT_RESPONSE_PREFIX) {
        let kind: Option<(String,)> =
            query_as("SELECT kind FROM cloud_chat_conversations WHERE conversation_id = $1")
                .bind(conversation_id)
                .fetch_optional(&mut **transaction)
                .await?;
        kind.is_some_and(|(kind,)| kind == "direct")
    } else {
        false
    };
    if let Some(stripped) = stripped_agent_body(body, direct) {
        *text = Value::String(stripped);
    }
    Ok(())
}

#[cfg(test)]
#[path = "local_paths_tests.rs"]
mod tests;
