//! Inline formats the editor writes into Markdown: `<u>` and `<mark>` are the
//! only inline HTML that survives sanitizing, and `==text==` renders as
//! `<mark>text</mark>`. Code spans are separate events and code blocks are
//! skipped, so `==` inside code stays literal.

use pulldown_cmark::{CowStr, Event, Tag, TagEnd};

const ALLOWED_INLINE_HTML: [&str; 4] = ["<u>", "</u>", "<mark>", "</mark>"];

/// True for exactly `<u>`, `</u>`, `<mark>`, and `</mark>`.
pub(crate) fn is_allowed_inline_html(html: &str) -> bool {
    ALLOWED_INLINE_HTML.contains(&html)
}

/// Splits `text` into plain and highlighted runs. `==x==` is highlighted
/// when the opening marker is followed by, and the closing marker preceded
/// by, a non-space character (so `a == b` stays literal); an unmatched `==`
/// stays literal.
pub(crate) fn split_highlights(text: &str) -> Vec<(bool, String)> {
    let mut runs: Vec<(bool, String)> = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    while let Some(open) = rest.find("==") {
        let after = &rest[open + 2..];
        let opens = after
            .chars()
            .next()
            .is_some_and(|ch| !ch.is_whitespace() && ch != '=');
        let close = opens
            .then(|| {
                after
                    .match_indices("==")
                    .map(|(index, _)| index)
                    .find(|index| {
                        *index > 0
                            && after[..*index]
                                .chars()
                                .last()
                                .is_some_and(|ch| !ch.is_whitespace())
                    })
            })
            .flatten();
        let Some(close) = close else {
            plain.push_str(&rest[..open + 2]);
            rest = after;
            continue;
        };
        plain.push_str(&rest[..open]);
        if !plain.is_empty() {
            runs.push((false, std::mem::take(&mut plain)));
        }
        runs.push((true, after[..close].to_string()));
        rest = &after[close + 2..];
    }
    plain.push_str(rest);
    if !plain.is_empty() {
        runs.push((false, plain));
    }
    runs
}

fn is_inline_end(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link | TagEnd::Image
    )
}

/// Applies highlights and balances `<u>` and `<mark>` inside each leaf
/// block, after sanitizing removed every other inline HTML event.
pub(crate) fn apply_inline_formats(events: Vec<Event<'_>>) -> Vec<Event<'_>> {
    // Coalesce adjacent text so a highlight split across text events still matches.
    let mut coalesced: Vec<Event<'_>> = Vec::with_capacity(events.len());
    for event in events {
        match (coalesced.last_mut(), event) {
            (Some(Event::Text(previous)), Event::Text(next)) => {
                *previous = CowStr::from(format!("{previous}{next}"));
            }
            (_, event) => coalesced.push(event),
        }
    }
    let mut out: Vec<Event<'_>> = Vec::with_capacity(coalesced.len());
    let mut code_depth = 0usize;
    let mut open: Vec<&'static str> = Vec::new();
    for event in coalesced {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                code_depth += 1;
                out.push(Event::Start(Tag::CodeBlock(kind)));
            }
            Event::End(TagEnd::CodeBlock) => {
                code_depth = code_depth.saturating_sub(1);
                out.push(Event::End(TagEnd::CodeBlock));
            }
            Event::Text(text) if code_depth == 0 && text.contains("==") => {
                for (marked, run) in split_highlights(&text) {
                    if marked {
                        out.push(Event::InlineHtml("<mark>".into()));
                        out.push(Event::Text(run.into()));
                        out.push(Event::InlineHtml("</mark>".into()));
                    } else {
                        out.push(Event::Text(run.into()));
                    }
                }
            }
            Event::InlineHtml(html) => match html.as_ref() {
                "<u>" => {
                    open.push("u");
                    out.push(Event::InlineHtml(html));
                }
                "<mark>" => {
                    open.push("mark");
                    out.push(Event::InlineHtml(html));
                }
                "</u>" | "</mark>" => {
                    let name = if html.as_ref() == "</u>" { "u" } else { "mark" };
                    if let Some(position) = open.iter().rposition(|tag| *tag == name) {
                        open.remove(position);
                        out.push(Event::InlineHtml(html));
                    }
                }
                _ => {}
            },
            Event::End(tag) if !is_inline_end(&tag) && !open.is_empty() => {
                while let Some(name) = open.pop() {
                    out.push(Event::InlineHtml(format!("</{name}>").into()));
                }
                out.push(Event::End(tag));
            }
            other => out.push(other),
        }
    }
    while let Some(name) = open.pop() {
        out.push(Event::InlineHtml(format!("</{name}>").into()));
    }
    out
}
