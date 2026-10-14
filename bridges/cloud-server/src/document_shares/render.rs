//! Markdown block splitting, sanitizing, and title extraction.
//!
//! Blocks are the top-level Markdown blocks in source order with ids `b0`,
//! `b1`, ... Every top-level block counts, including raw HTML blocks whose
//! sanitized HTML is empty, so ids stay stable for clients that compute them
//! from the same source.

use std::ops::Range;

use pulldown_cmark::{html, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use super::block_ids::{assign_ids, remove_block_comments, split_block_id, standalone_block_id};
use super::inline_formats::{apply_inline_formats, is_allowed_inline_html};
use super::model::{DocumentBlock, DocumentFormat};

const MAX_TITLE_CHARS: usize = 200;

fn markdown_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Splits `source` into top-level blocks with sanitized HTML. A block takes
/// a stable id from `<!-- k:... -->` at the end of its last line or on its
/// own line right after it (see [`super::block_ids`]); every other block
/// keeps `b{index}`.
pub(crate) fn markdown_blocks(source: &str) -> Vec<DocumentBlock> {
    markdown_block_spans(source)
        .into_iter()
        .map(|(block, _)| block)
        .collect()
}

/// [`markdown_blocks`] with the byte range each block occupies in `source`,
/// from its first character to the end of its content or of the block-id
/// comment that names it. Text between ranges (blank lines, link reference
/// definitions) belongs to no block.
pub(crate) fn markdown_block_spans(source: &str) -> Vec<(DocumentBlock, Range<usize>)> {
    let mut raw: Vec<RawBlock> = Vec::new();
    let mut depth = 0usize;
    let mut current: Vec<Event<'_>> = Vec::new();
    let mut start = 0usize;
    for (event, range) in Parser::new_ext(source, markdown_options()).into_offset_iter() {
        match &event {
            Event::Start(_) => {
                if depth == 0 {
                    start = range.start;
                    current.clear();
                }
                depth += 1;
                current.push(event);
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                current.push(event);
                if depth == 0 {
                    let end = range.end.max(start);
                    push_block(&mut raw, source, start..end, &current);
                    current.clear();
                }
            }
            _ if depth == 0 => {
                push_block(&mut raw, source, range, &[event]);
            }
            _ => current.push(event),
        }
    }
    let rest: Vec<(String, Range<usize>)> = raw
        .iter()
        .map(|block| (block.html.clone(), block.start..block.end))
        .collect();
    assign_ids(
        raw.into_iter()
            .map(|block| (block.source, block.id))
            .collect(),
    )
    .into_iter()
    .zip(rest)
    .map(|((id, source), (html, range))| (DocumentBlock { id, source, html }, range))
    .collect()
}

struct RawBlock {
    source: String,
    id: Option<String>,
    html: String,
    start: usize,
    /// Byte offset just after the block's last non-whitespace character.
    content_end: usize,
    /// `content_end`, or the end of the block-id comment on the next line.
    end: usize,
}

/// Adds a top-level block, or, when the block is only a block-id comment,
/// gives that id to the block right before it (no blank line between). Such
/// a comment is never a block of its own and never takes an index.
fn push_block(raw: &mut Vec<RawBlock>, source: &str, range: Range<usize>, events: &[Event<'_>]) {
    let text = &source[range.clone()];
    if let Some(id) = standalone_block_id(text) {
        if let Some(previous) = raw.last_mut() {
            let gap = &source[previous.content_end..range.start];
            if gap.matches('\n').count() <= 1 && previous.id.is_none() {
                previous.id = Some(id);
                previous.end = range.start + text.trim_end().len();
            }
        }
        return;
    }
    let (clean, id) = split_block_id(text.trim_end_matches(['\n', '\r']));
    let content_end = range.start + text.trim_end().len();
    raw.push(RawBlock {
        source: clean,
        id,
        html: sanitized_html(events),
        start: range.start,
        content_end,
        end: content_end,
    });
}

pub(crate) fn link_is_allowed(destination: &str) -> bool {
    let lower = destination.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

pub(crate) fn image_is_allowed(destination: &str) -> bool {
    let lower = destination.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("data:image/")
}

/// Renders `events` after dropping raw HTML other than `<u>` and `<mark>`, links with schemes other than
/// http, https, and mailto (their text stays), and images whose source is
/// not https or `data:image/` (with their alt text). Links that remain get
/// `rel="noopener noreferrer"`.
fn sanitized_html(events: &[Event<'_>]) -> String {
    let mut kept: Vec<Event<'_>> = Vec::with_capacity(events.len());
    let mut dropping_link = false;
    let mut dropped_image_depth = 0usize;
    for event in events {
        if dropped_image_depth > 0 {
            match event {
                Event::Start(Tag::Image { .. }) => dropped_image_depth += 1,
                Event::End(TagEnd::Image) => dropped_image_depth -= 1,
                _ => {}
            }
            continue;
        }
        match event {
            Event::InlineHtml(html) if is_allowed_inline_html(html) => kept.push(event.clone()),
            Event::Text(text) if text.contains("<!--") => {
                kept.push(Event::Text(remove_block_comments(text).into()));
            }
            Event::Code(text) if text.contains("<!--") => {
                kept.push(Event::Code(remove_block_comments(text).into()));
            }
            Event::InlineHtml(html) if remove_block_comments(html).trim().is_empty() => {
                // A block-id comment: drop it with the space that led up to it.
                if let Some(Event::Text(text)) = kept.last_mut() {
                    *text = text.trim_end_matches([' ', '\t']).to_string().into();
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::Start(Tag::HtmlBlock) | Event::End(TagEnd::HtmlBlock) => {}
            Event::Start(Tag::Link { dest_url, .. }) if !link_is_allowed(dest_url) => {
                dropping_link = true;
            }
            Event::End(TagEnd::Link) if dropping_link => dropping_link = false,
            Event::Start(Tag::Image { dest_url, .. }) if !image_is_allowed(dest_url) => {
                dropped_image_depth = 1;
            }
            other => kept.push(other.clone()),
        }
    }
    let mut out = String::new();
    html::push_html(&mut out, apply_inline_formats(kept).into_iter());
    // Raw HTML is gone and text is escaped, so every `<a href` is a link tag.
    out.replace("<a href=\"", "<a rel=\"noopener noreferrer\" href=\"")
}

/// The plain text of the first level-1 heading.
pub(crate) fn markdown_title(source: &str) -> Option<String> {
    let mut in_title = false;
    let mut text = String::new();
    for event in Parser::new_ext(source, markdown_options()) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => in_title = true,
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if in_title => {
                return clean_title(&text);
            }
            Event::Text(value) | Event::Code(value) if in_title => text.push_str(&value),
            Event::SoftBreak | Event::HardBreak if in_title => text.push(' '),
            _ => {}
        }
    }
    None
}

/// The text of the `<title>` element of an HTML document.
pub(crate) fn html_title(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let content_start = open + lower[open..].find('>')? + 1;
    let content_end = content_start + lower[content_start..].find("</title")?;
    let decoded = source[content_start..content_end]
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    clean_title(&decoded)
}

fn clean_title(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = collapsed.chars().take(MAX_TITLE_CHARS).collect();
    (!title.is_empty()).then_some(title)
}

pub(crate) fn file_stem(file_name: &str) -> String {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let stem = match base.rfind('.') {
        Some(index) if index > 0 => &base[..index],
        _ => base,
    };
    clean_title(stem).unwrap_or_else(|| "Document".to_string())
}

/// Title for a document: the first level-1 heading (Markdown) or `<title>`
/// (HTML), then the title someone renamed a Markdown document to, else the
/// file name without its extension. A leading heading wins over a rename
/// because readers show it as the title in the body.
pub(crate) fn document_title(
    format: DocumentFormat,
    source: &str,
    stored: Option<&str>,
    file_name: &str,
) -> String {
    let found = match format {
        DocumentFormat::Markdown => markdown_title(source).or_else(|| stored.and_then(clean_title)),
        DocumentFormat::Html => html_title(source),
    };
    found.unwrap_or_else(|| file_stem(file_name))
}

/// A renamed title: whitespace collapsed, 1 to 200 characters.
pub(crate) fn valid_document_title(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars = collapsed.chars().count();
    (chars > 0 && chars <= MAX_TITLE_CHARS && !collapsed.chars().any(char::is_control))
        .then_some(collapsed)
}

/// Blocks for either format. An HTML document is the single block `b0`.
pub(crate) fn document_blocks(format: DocumentFormat, source: &str) -> Vec<DocumentBlock> {
    match format {
        DocumentFormat::Markdown => markdown_blocks(source),
        DocumentFormat::Html => vec![DocumentBlock {
            id: "b0".to_string(),
            source: String::new(),
            html: String::new(),
        }],
    }
}

/// The document format for a content type, falling back to the file name.
pub(crate) fn document_format(content_type: &str, file_name: &str) -> Option<DocumentFormat> {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "text/markdown" | "text/x-markdown" => return Some(DocumentFormat::Markdown),
        "text/html" | "application/xhtml+xml" => return Some(DocumentFormat::Html),
        "" | "text/plain" | "application/octet-stream" => {}
        _ => return None,
    }
    let lower = file_name.to_ascii_lowercase();
    if [".md", ".markdown"].iter().any(|ext| lower.ends_with(ext)) {
        Some(DocumentFormat::Markdown)
    } else if [".html", ".htm"].iter().any(|ext| lower.ends_with(ext)) {
        Some(DocumentFormat::Html)
    } else {
        None
    }
}

/// Where each old block's annotations go after an edit, given the old and
/// new block sources. A block whose trimmed source still exists keeps its
/// annotations at the first unmatched occurrence in order; `None` means the
/// block disappeared (see [`super::block_ids::annotation_targets`]).
pub(crate) fn remap_block_ids(old_blocks: &[String], new_blocks: &[String]) -> Vec<Option<usize>> {
    let mut available: std::collections::HashMap<&str, std::collections::VecDeque<usize>> =
        std::collections::HashMap::new();
    for (index, source) in new_blocks.iter().enumerate() {
        available.entry(source.trim()).or_default().push_back(index);
    }
    old_blocks
        .iter()
        .map(|source| {
            available
                .get_mut(source.trim())
                .and_then(std::collections::VecDeque::pop_front)
        })
        .collect()
}
