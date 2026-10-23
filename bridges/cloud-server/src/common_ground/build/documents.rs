//! Kordi documents a card build reads: the owner's own Markdown documents
//! they picked, checked again here, redacted like every other source.

use crate::common_ground::documents::eligible;
use crate::common_ground::profiles::MAX_DOCUMENTS;
use crate::common_ground::prompt::Gathered;
use crate::common_ground::redact::{redact, squeeze};
use crate::document_shares::access::canonical_record;
use crate::document_shares::contents::document_source;
use crate::document_shares::model::DocumentFormat;
use crate::server::ServerState;

pub(super) const DOCUMENTS_SOURCE: &str = "Documents";
const MAX_DOCUMENT_TEXT_CHARS: usize = 2000;
const MAX_TITLE_CHARS: usize = 140;
/// Text read before redaction; far past what the card keeps.
const MAX_READ_CHARS: usize = 20_000;

/// One item per picked document the account may use, in the order picked.
/// Missing, ineligible and unreadable documents are skipped.
pub(super) async fn gather_documents(
    state: &ServerState,
    account: &str,
    ids: &[String],
) -> sqlx_core::Result<Vec<Gathered>> {
    let mut wanted: Vec<String> = Vec::new();
    for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if wanted.len() == MAX_DOCUMENTS {
            break;
        }
        if !wanted.iter().any(|kept| kept == id) {
            wanted.push(id.to_string());
        }
    }
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let pool = state.db_pool();
    let found = eligible(pool, account, Some(&wanted)).await?;
    let mut gathered = Vec::new();
    for id in &wanted {
        let Some(document) = found.iter().find(|doc| &doc.attachment_id == id) else {
            continue;
        };
        let record = match canonical_record(pool, id).await {
            Ok(Some(record)) if record.format == DocumentFormat::Markdown => record,
            _ => continue,
        };
        let text = match document_source(state, &record).await {
            Ok(source) => source.text,
            Err(_) => {
                eprintln!("[common-ground] Could not read document {id} for a card build");
                continue;
            }
        };
        let text: String = text.chars().take(MAX_READ_CHARS).collect();
        let text = squeeze(&redact(&text), MAX_DOCUMENT_TEXT_CHARS);
        if text.is_empty() {
            continue;
        }
        gathered.push(Gathered {
            source: DOCUMENTS_SOURCE.into(),
            title: squeeze(&redact(&document.title), MAX_TITLE_CHARS),
            date: Some(document.updated_at.date_naive().to_string()),
            url: None,
            text,
        });
    }
    Ok(gathered)
}
