//! Stable block ids written by the document editor.
//!
//! The editor stamps a top-level block with a trailing HTML comment on its
//! last line, `<!-- k:7f3a9c2d -->` (`k:` plus 4 to 32 characters of
//! `[A-Za-z0-9_-]`). The block's id is then `k:7f3a9c2d` instead of its
//! index id `b{index}`. Block sources and rendered HTML never contain these
//! comments; the stored document source keeps them.

use std::collections::{HashMap, HashSet};

use super::model::DocumentBlock;
use super::render::remap_block_ids;

const MIN_KEY_LEN: usize = 4;
const MAX_KEY_LEN: usize = 32;

/// `k:` plus 4 to 32 characters of `[A-Za-z0-9_-]`.
pub(crate) fn is_stable_block_id(value: &str) -> bool {
    value.strip_prefix("k:").is_some_and(|key| {
        (MIN_KEY_LEN..=MAX_KEY_LEN).contains(&key.len())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

/// Byte ranges and ids of every block-id comment in `text`.
fn comment_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(offset) = text[from..].find("<!--") {
        let start = from + offset;
        let body_start = start + 4;
        let Some(close) = text[body_start..].find("-->") else {
            break;
        };
        let inner = text[body_start..body_start + close].trim();
        if is_stable_block_id(inner) {
            let end = body_start + close + 3;
            spans.push((start, end, inner.to_string()));
            from = end;
        } else {
            from = body_start;
        }
    }
    spans
}

/// `text` without block-id comments. Lines that held one lose their
/// trailing spaces too.
pub(crate) fn remove_block_comments(text: &str) -> String {
    if !text.contains("<!--") {
        return text.to_string();
    }
    let spans = comment_spans(text);
    if spans.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut line = String::new();
    let mut line_had_comment = false;
    let mut index = 0;
    let mut spans = spans.into_iter().peekable();
    while index < text.len() {
        if let Some((start, end, _)) = spans.peek() {
            if *start == index {
                index = *end;
                line_had_comment = true;
                spans.next();
                continue;
            }
        }
        let ch = text[index..]
            .chars()
            .next()
            .expect("index is on a char boundary");
        index += ch.len_utf8();
        if ch == '\n' {
            flush_line(&mut out, &mut line, line_had_comment);
            out.push('\n');
            line_had_comment = false;
        } else {
            line.push(ch);
        }
    }
    flush_line(&mut out, &mut line, line_had_comment);
    out
}

fn flush_line(out: &mut String, line: &mut String, trim: bool) {
    if trim {
        out.push_str(line.trim_end_matches([' ', '\t']));
    } else {
        out.push_str(line);
    }
    line.clear();
}

/// The block's stable id, if its last line ends with a block-id comment
/// (only whitespace and further block-id comments may follow it), and the
/// source without any block-id comment.
pub(crate) fn split_block_id(source: &str) -> (String, Option<String>) {
    let spans = comment_spans(source);
    if spans.is_empty() {
        return (source.to_string(), None);
    }
    let last_line_start = source.trim_end().rfind('\n').map_or(0, |index| index + 1);
    let id = spans
        .iter()
        .find(|(start, end, _)| {
            *start >= last_line_start && {
                let rest = remove_block_comments(&source[*end..]);
                rest.trim().is_empty()
            }
        })
        .map(|(_, _, id)| id.clone());
    (remove_block_comments(source).trim_end().to_string(), id)
}

/// Gives each block its stable id unless an earlier block already used it,
/// in which case the block keeps its index id.
pub(crate) fn assign_ids(raw: Vec<(String, Option<String>)>) -> Vec<(String, String)> {
    let mut used = HashSet::new();
    raw.into_iter()
        .enumerate()
        .map(|(index, (source, id))| match id {
            Some(id) if used.insert(id.clone()) => (id, source),
            _ => (format!("b{index}"), source),
        })
        .collect()
}

/// Where annotations move on a save, as `old block id -> new block id` for
/// every id that changes.
///
/// - `stamped` (from the save's `blockIds`) moves index ids to the stable
///   ids the editor just assigned.
/// - A stable id that still exists stays where it is.
/// - An index id follows its block by source (see
///   [`super::render::remap_block_ids`]) and takes the new block's id.
/// - A block that disappeared hands its annotations to the nearest preceding
///   surviving block in the old document, else the first new block (`b0`).
pub(crate) fn annotation_targets(
    old: &[DocumentBlock],
    new: &[DocumentBlock],
    stamped: &HashMap<String, String>,
) -> HashMap<String, String> {
    let old_sources: Vec<String> = old.iter().map(|block| block.source.clone()).collect();
    let new_sources: Vec<String> = new.iter().map(|block| block.source.clone()).collect();
    let by_source = remap_block_ids(&old_sources, &new_sources);
    let new_ids: HashSet<&str> = new.iter().map(|block| block.id.as_str()).collect();
    let survivors: Vec<Option<String>> = old
        .iter()
        .zip(&by_source)
        .map(|(block, matched)| {
            if is_stable_block_id(&block.id) {
                new_ids
                    .contains(block.id.as_str())
                    .then(|| block.id.clone())
            } else {
                matched.map(|index| new[index].id.clone())
            }
        })
        .collect();
    let first = new
        .first()
        .map_or_else(|| "b0".to_string(), |block| block.id.clone());
    // Reuse the index fallback for "nearest preceding survivor".
    let positions: Vec<Option<usize>> = survivors
        .iter()
        .enumerate()
        .map(|(index, survivor)| survivor.as_ref().map(|_| index))
        .collect();
    let mut targets = HashMap::new();
    for (index, block) in old.iter().enumerate() {
        let target = match &survivors[index] {
            Some(id) => id.clone(),
            None => match positions[..index].iter().rev().flatten().next() {
                Some(previous) => survivors[*previous]
                    .clone()
                    .unwrap_or_else(|| first.clone()),
                None => first.clone(),
            },
        };
        if target != block.id {
            targets.insert(block.id.clone(), target);
        }
    }
    for (from, to) in stamped {
        if from != to {
            targets.insert(from.clone(), to.clone());
        }
    }
    targets
}
