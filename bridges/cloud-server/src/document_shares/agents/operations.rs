//! Applying `edit_document` operations to a document's Markdown.
//!
//! Operations name blocks by the ids `read_document` returned at the base
//! revision. Every block the call does not touch keeps its exact source
//! bytes, id comment included, and so does the text between blocks. A
//! replaced block keeps its id; a block that had only an index id is given a
//! stable id so its comments and reactions follow it. Every inserted block
//! is stamped with a new stable id. A call is applied whole or not at all.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::super::block_ids::{is_stable_block_id, remove_block_comments};
use super::super::render::markdown_block_spans;
use super::{MAX_EDIT_OPERATIONS, MAX_TOOL_TEXT_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    Replace,
    InsertAfter,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Operation {
    pub op: OperationKind,
    pub block_id: String,
    #[serde(default)]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OperationError {
    /// No operations, or more than [`MAX_EDIT_OPERATIONS`].
    Count,
    /// The Markdown of the call is larger than [`MAX_TOOL_TEXT_BYTES`].
    TooLarge,
    /// The block is not in the document at the base revision, or an earlier
    /// operation of this call deleted it.
    UnknownBlock(String),
    /// `replace` or `insert_after` without Markdown that forms a block.
    MissingMarkdown(String),
}

impl OperationError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Count => format!("Send 1 to {MAX_EDIT_OPERATIONS} operations."),
            Self::TooLarge => format!(
                "The Markdown of one call can be up to {} kB.",
                MAX_TOOL_TEXT_BYTES / 1000
            ),
            Self::UnknownBlock(id) => format!(
                "Block {id} is not in the document. Read the document again and use its block ids."
            ),
            Self::MissingMarkdown(id) => {
                format!("The operation on block {id} needs Markdown for at least one block.")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedOperations {
    pub text: String,
    /// Index ids of the old document mapped to the stable ids their replaced
    /// blocks now carry; the save moves annotations along this map.
    pub stamped: HashMap<String, String>,
    /// Ids of the blocks this call inserted, in document order per operation.
    pub new_block_ids: Vec<String>,
}

struct Slot {
    id: String,
    original: String,
    replacement: Option<String>,
    deleted: bool,
    inserted: Vec<String>,
}

enum Segment {
    Gap(String),
    Block(Slot),
}

/// Checks the limits that do not depend on the document.
pub(crate) fn validate_operations(operations: &[Operation]) -> Result<(), OperationError> {
    if operations.is_empty() || operations.len() > MAX_EDIT_OPERATIONS {
        return Err(OperationError::Count);
    }
    let bytes: usize = operations
        .iter()
        .filter_map(|operation| operation.markdown.as_deref())
        .map(str::len)
        .sum();
    if bytes > MAX_TOOL_TEXT_BYTES {
        return Err(OperationError::TooLarge);
    }
    Ok(())
}

/// Stamps the blocks of `markdown`: the first takes `first_id` when given,
/// every other block a new id. Id comments the caller wrote are dropped
/// first, so a call cannot claim another block's id. Returns the stamped
/// Markdown and the ids in order, or `None` when it holds no block.
fn stamp_blocks(
    markdown: &str,
    first_id: Option<&str>,
    new_id: &mut dyn FnMut() -> String,
) -> Option<(String, Vec<String>)> {
    let clean = remove_block_comments(markdown);
    let clean = clean.trim_matches(['\n', '\r']).trim_end();
    let spans = markdown_block_spans(clean);
    if spans.is_empty() {
        return None;
    }
    let ids: Vec<String> = (0..spans.len())
        .map(|index| match (index, first_id) {
            (0, Some(id)) => id.to_string(),
            _ => new_id(),
        })
        .collect();
    let mut text = clean.to_string();
    for ((_, range), id) in spans.iter().zip(&ids).rev() {
        text.insert_str(range.end, &format!("\n<!-- {id} -->"));
    }
    Some((text, ids))
}

/// Applies `operations` to `source`. `new_id` returns a fresh stable id
/// (`k:...`) on each call; ids already in the document are skipped.
pub(crate) fn apply_operations(
    source: &str,
    operations: &[Operation],
    new_id: &mut dyn FnMut() -> String,
) -> Result<AppliedOperations, OperationError> {
    validate_operations(operations)?;
    let spans = markdown_block_spans(source);
    let mut used: HashSet<String> = spans.iter().map(|(block, _)| block.id.clone()).collect();
    let mut fresh = || loop {
        let id = new_id();
        if is_stable_block_id(&id) && used.insert(id.clone()) {
            return id;
        }
    };
    let mut segments = Vec::with_capacity(spans.len() * 2 + 1);
    let mut cursor = 0;
    for (block, range) in &spans {
        segments.push(Segment::Gap(source[cursor..range.start].to_string()));
        segments.push(Segment::Block(Slot {
            id: block.id.clone(),
            original: source[range.clone()].to_string(),
            replacement: None,
            deleted: false,
            inserted: Vec::new(),
        }));
        cursor = range.end;
    }
    segments.push(Segment::Gap(source[cursor..].to_string()));

    let mut stamped = HashMap::new();
    let mut new_block_ids = Vec::new();
    for operation in operations {
        let block_id = operation.block_id.trim();
        let slot = segments
            .iter_mut()
            .find_map(|segment| match segment {
                Segment::Block(slot) if slot.id == block_id && !slot.deleted => Some(slot),
                _ => None,
            })
            .ok_or_else(|| OperationError::UnknownBlock(block_id.to_string()))?;
        let markdown = operation.markdown.as_deref().unwrap_or_default();
        let missing = || OperationError::MissingMarkdown(block_id.to_string());
        match operation.op {
            OperationKind::Delete => slot.deleted = true,
            OperationKind::Replace => {
                let keep = match stamped.get(&slot.id) {
                    Some(id) => String::clone(id),
                    None if is_stable_block_id(&slot.id) => slot.id.clone(),
                    None => fresh(),
                };
                let (text, ids) =
                    stamp_blocks(markdown, Some(&keep), &mut fresh).ok_or_else(missing)?;
                if keep != slot.id {
                    stamped.insert(slot.id.clone(), keep);
                }
                new_block_ids.extend(ids.into_iter().skip(1));
                slot.replacement = Some(text);
            }
            OperationKind::InsertAfter => {
                let (text, ids) = stamp_blocks(markdown, None, &mut fresh).ok_or_else(missing)?;
                new_block_ids.extend(ids);
                // Later inserts after the same block go right after it.
                slot.inserted.insert(0, text);
            }
        }
    }

    let mut text = String::with_capacity(source.len());
    let mut after_deleted = false;
    for segment in segments {
        match segment {
            Segment::Gap(gap) => {
                // The gap before a deleted block already separates its neighbors.
                if after_deleted {
                    text.push_str(gap.trim_start_matches(['\n', '\r']));
                } else {
                    text.push_str(&gap);
                }
                after_deleted = false;
            }
            Segment::Block(slot) => {
                let mut parts = Vec::with_capacity(slot.inserted.len() + 1);
                if !slot.deleted {
                    parts.push(slot.replacement.unwrap_or(slot.original));
                }
                parts.extend(slot.inserted);
                after_deleted = parts.is_empty();
                text.push_str(&parts.join("\n\n"));
            }
        }
    }
    let mut text = text.trim_end().to_string();
    text.push('\n');
    Ok(AppliedOperations {
        text,
        stamped,
        new_block_ids,
    })
}

/// A new stable block id, like the editor's.
pub(crate) fn random_block_id() -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("k:{}", &random[..8])
}
