//! `create_document`: a document an agent writes for a group, saved as that
//! group's Markdown or HTML attachment (issue 1808).
//!
//! The document is uploaded under the agent's owner, like every agent
//! artifact, so the owner's sharing and editing rules apply, and it is
//! recorded against the run (`cloud_agent_run_documents`). It is not a
//! message of its own: [`reply`] attaches it to the agent's reply when the
//! reply is published, on every path that publishes one (the Mac's
//! progress route, cloud completion, and a background task's follow-up).
//! It then shows inside the reply as a document card, from the agent, and
//! in the group's Artifacts. Only a document that no reply took is posted as
//! the agent's own message by [`fallback`].
//!
//! Retrying the same call is harmless: the attachment id is derived from the
//! run, the file name, and the content.

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::tools::ToolError;
use super::MAX_TOOL_TEXT_BYTES;

pub(crate) mod fallback;
mod group_message;
mod record;
pub(crate) mod reply;

pub(crate) use record::execute;

/// Longest title, in characters, like a document rename.
pub(crate) const MAX_TITLE_CHARS: usize = 200;
/// Most documents one run may create.
pub(crate) const MAX_DOCUMENTS_PER_RUN: i64 = 10;
/// Longest file name stem derived from a title.
const MAX_FILE_STEM_CHARS: usize = 80;

pub(crate) fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_TITLE_CHARS,
                "description": "A specific title for this document, such as \"Q3 launch plan\". \
                    It names the file. Never empty, never a placeholder such as \"Untitled\"."
            },
            "content": {
                "type": "string",
                "minLength": 1,
                "description": "The complete, finished document: Markdown, or a full HTML page \
                    when format is html. Never a stub or an empty draft."
            },
            "format": {
                "type": "string",
                "enum": ["markdown", "html"],
                "description": "markdown (the default) or html."
            }
        },
        "required": ["title", "content"],
        "additionalProperties": false
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArguments {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    format: Option<String>,
}

/// A validated document ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewDocument {
    pub title: String,
    pub file_name: String,
    pub content_type: &'static str,
    pub content: String,
}

impl NewDocument {
    pub(crate) fn format(&self) -> &'static str {
        if self.content_type == "text/html" {
            "html"
        } else {
            "markdown"
        }
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Titles that name no document: what an editor calls a new, empty file.
fn placeholder_title(title: &str) -> bool {
    let lowered = title.to_lowercase();
    let stem = lowered
        .trim_end_matches(".markdown")
        .trim_end_matches(".md")
        .trim_end_matches(".html")
        .trim_end_matches(".htm")
        .trim();
    let words: Vec<&str> = stem.split_whitespace().collect();
    matches!(
        words.as_slice(),
        ["untitled" | "document" | "doc" | "new" | "title" | "file"]
            | ["untitled" | "new", "document" | "doc" | "file"]
    ) || (words.len() == 2
        && words[0] == "untitled"
        && words[1].chars().all(|ch| ch.is_ascii_digit()))
}

/// A file name for `title`: lowercase letters and digits joined by hyphens,
/// at most [`MAX_FILE_STEM_CHARS`] before the extension.
pub(crate) fn file_name_for(title: &str, extension: &str) -> String {
    let lowered = title.to_lowercase();
    let stem = [".markdown", ".md", ".html", ".htm"]
        .iter()
        .find_map(|known| lowered.strip_suffix(known))
        .unwrap_or(&lowered);
    let mut slug = String::new();
    for ch in stem.chars() {
        if ch.is_alphanumeric() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(MAX_FILE_STEM_CHARS).collect();
    let slug = slug.trim_matches('-');
    format!(
        "{}.{extension}",
        if slug.is_empty() { "document" } else { slug }
    )
}

fn invalid(message: &str) -> ToolError {
    ToolError::Invalid(format!(
        "{message} Write the whole document first, then call create_document once with a \
         specific title and the finished content."
    ))
}

/// Checks the arguments of one call.
pub(crate) fn parse(args: &Value) -> Result<NewDocument, ToolError> {
    let input: CreateArguments = serde_json::from_value(args.clone())
        .map_err(|_| invalid("create_document needs a title and the document content."))?;
    let title = collapse_whitespace(input.title.as_deref().unwrap_or_default());
    if title.is_empty() {
        return Err(invalid("The title is missing."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid(&format!(
            "The title is longer than {MAX_TITLE_CHARS} characters."
        )));
    }
    if placeholder_title(&title) {
        return Err(invalid(&format!(
            "\"{title}\" is a placeholder, not a title. Name the document after what it covers."
        )));
    }
    let (content_type, extension) = match input.format.as_deref().map(str::trim) {
        None | Some("") | Some("markdown") | Some("md") => ("text/markdown", "md"),
        Some("html") => ("text/html", "html"),
        Some(_) => {
            return Err(invalid(
                "format must be markdown or html. Attach other formats as ordinary files.",
            ))
        }
    };
    let content = input.content.unwrap_or_default();
    if content.trim().is_empty() {
        return Err(invalid("The document content is empty."));
    }
    if content.len() > MAX_TOOL_TEXT_BYTES {
        return Err(ToolError::Invalid(format!(
            "The document is larger than {MAX_TOOL_TEXT_BYTES} bytes. Split it into parts."
        )));
    }
    Ok(NewDocument {
        file_name: file_name_for(&title, extension),
        title,
        content_type,
        content,
    })
}

/// Whether `session_id` names a group conversation.
pub(crate) async fn is_group_session(
    pool: &PgPool,
    session_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (group,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversations \
         WHERE legacy_session_id = $1 AND kind = 'group')",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;
    Ok(group)
}

#[cfg(test)]
#[path = "create_tests.rs"]
mod tests;
