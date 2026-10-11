//! The public document page at `/d/:token` and the raw HTML route.
//!
//! Markdown renders server-side; HTML documents render inside a sandboxed
//! iframe served from `/d/:token/raw`. The inline style and script carry a
//! per-response nonce, and the page CSP allows nothing else.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Extension;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;

use super::access::{document_source, public_document, DocumentRecord};
use super::documents::raw_html_response;
use super::model::{DocumentAuthor, DocumentFormat};
use super::render::{document_blocks, document_title, markdown_title};
use super::tokens::{public_raw_path, share_deep_link};
use super::{observe_public, PublicAccess};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::server::ServerState;

const PAGE_CSS: &str = include_str!("assets/page.css");
const PAGE_JS: &str = include_str!("assets/page.js");
const KORDI_HOMEPAGE_URL: &str = "https://kordi.ai/";
const KORDI_FAVICON_URL: &str = "/assets/favicon.png";

const BRAND_MARK: &str = r#"<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="10" r="9" fill="currentColor" opacity=".62"></circle><circle cx="11" cy="22" r="9" fill="currentColor" opacity=".82"></circle><circle cx="25" cy="22" r="9" fill="currentColor"></circle></svg>"#;
const CALENDAR_ICON: &str = r#"<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>"#;
const LOCK_ICON: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>"#;
const COMMENT_ICON: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M12 8v5M9.5 10.5h5"/></svg>"#;
const REACT_ICON: &str = r#"<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9 14s1 1.5 3 1.5 3-1.5 3-1.5M9.5 10h.01M14.5 10h.01"/></svg>"#;

pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(crate) fn new_nonce() -> String {
    let mut bytes = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn page_csp(nonce: &str) -> String {
    format!(
        "default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; \
         img-src https: data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; \
         form-action 'none'"
    )
}

/// "Oct 9, 2026" from an RFC 3339 timestamp.
fn date_label(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.format("%b %-d, %Y").to_string())
        .unwrap_or_default()
}

/// "Kordi 123 456 789".
fn kordi_id_label(kordi_id: &str) -> String {
    let digits: Vec<char> = kordi_id.chars().collect();
    let groups: Vec<String> = digits
        .chunks(3)
        .map(|chunk| chunk.iter().collect())
        .collect();
    format!("Kordi {}", groups.join(" "))
}

fn initials(name: &str) -> String {
    let letters: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|part| part.chars().next())
        .flat_map(char::to_uppercase)
        .collect();
    if letters.is_empty() {
        "?".to_string()
    } else {
        letters
    }
}

fn avatar_html(author: &DocumentAuthor) -> String {
    match author.avatar_url.as_deref() {
        Some(url) if url.starts_with("https://") || url.starts_with("data:image/") => format!(
            r#"<span class="av"><img alt="" src="{}"></span>"#,
            escape_html(url)
        ),
        _ => format!(
            r#"<span class="av">{}</span>"#,
            escape_html(&initials(&author.display_name))
        ),
    }
}

/// Everything the page needs, separated from I/O so it can be tested.
pub(crate) struct PageInput<'a> {
    pub token: &'a str,
    pub record: &'a DocumentRecord,
    pub source: &'a str,
}

fn document_body(input: &PageInput<'_>, title: &str) -> String {
    match input.record.format {
        DocumentFormat::Html => format!(
            r#"<div class="block" data-block="b0"><iframe class="frame" sandbox src="{}" title="{}"></iframe></div><div class="annot" data-for="b0"></div>"#,
            escape_html(&public_raw_path(input.token)),
            escape_html(title),
        ),
        DocumentFormat::Markdown => {
            let blocks = document_blocks(DocumentFormat::Markdown, input.source);
            let skip_title = markdown_title(input.source).is_some()
                && blocks
                    .first()
                    .is_some_and(|block| block.html.starts_with("<h1>"));
            blocks
                .iter()
                .skip(usize::from(skip_title))
                .map(|block| {
                    format!(
                        r#"<div class="block" data-block="{id}">{html}</div><div class="annot" data-for="{id}"></div>"#,
                        id = escape_html(&block.id),
                        html = block.html,
                    )
                })
                .collect()
        }
    }
}

pub(crate) fn document_page(input: &PageInput<'_>, nonce: &str) -> String {
    let record = input.record;
    let title = document_title(record.format, input.source, &record.file_name);
    let author = &record.author;
    let name = escape_html(&author.display_name);
    let kordi_id = if author.kordi_id.is_empty() {
        String::new()
    } else {
        format!(
            r#"<div class="sub">{}</div>"#,
            escape_html(&kordi_id_label(&author.kordi_id))
        )
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" type="image/png" sizes="512x512" href="{favicon}">
<title>{title} &middot; Kordi</title>
<style nonce="{nonce}">{css}</style>
</head>
<body>
<header class="webbar"><a class="brand" href="{home}" aria-label="Kordi home">{brand}Kordi</a><a class="open" href="{deep_link}">Open in Kordi</a></header>
<main class="wrap doc" id="doc" data-token="{token}">
<h1>{title}</h1>
<div class="meta"><span class="pill">{calendar}{date}</span><span class="dot">&middot;</span><button class="mention" id="authorChip" aria-expanded="false" aria-controls="people">@{name}</button>
<div class="people" id="people" hidden><div class="cap">People</div><div class="prow">{avatar}<div class="who"><div class="name">{name}</div>{kordi_id}</div><a class="pact" href="{home}">Add on Kordi</a></div></div></div>
<div id="content">{body}</div>
<div class="tb" id="tb" hidden><button data-act="comment" aria-label="Comment">{comment_icon}</button><button data-act="react" aria-label="React">{react_icon}</button></div>
<div class="emo" id="emo" hidden></div>
<footer class="docfoot">Shared by <b>{name}</b></footer>
</main>
<div class="toast" id="toast" role="status" hidden></div>
<script nonce="{nonce}">{js}</script>
</body>
</html>"#,
        favicon = KORDI_FAVICON_URL,
        title = escape_html(&title),
        css = PAGE_CSS,
        home = KORDI_HOMEPAGE_URL,
        brand = BRAND_MARK,
        deep_link = escape_html(&share_deep_link(input.token)),
        token = escape_html(input.token),
        calendar = CALENDAR_ICON,
        date = escape_html(&date_label(&record.created_at)),
        avatar = avatar_html(author),
        body = document_body(input, &title),
        comment_icon = COMMENT_ICON,
        react_icon = REACT_ICON,
        js = PAGE_JS,
    )
}

pub(crate) fn link_off_page(nonce: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="512x512" href="{KORDI_FAVICON_URL}">
<title>This link is off &middot; Kordi</title>
<style nonce="{nonce}">{PAGE_CSS}</style>
</head>
<body>
<header class="webbar"><a class="brand" href="{KORDI_HOMEPAGE_URL}" aria-label="Kordi home">{BRAND_MARK}Kordi</a></header>
<main class="gone">{LOCK_ICON}<b>This link is off</b></main>
</body>
</html>"#
    )
}

fn html_response(status: StatusCode, nonce: &str, body: String) -> Response {
    let mut response = (status, Html(body)).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&page_csp(nonce)) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

/// `GET /d/:token`
pub(crate) async fn page(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Response {
    if let Err(response) = observe_public(
        &rate_limiter,
        &headers,
        connect_info.as_ref(),
        PublicAccess::Read,
    )
    .await
    {
        return response;
    }
    let nonce = new_nonce();
    let (_, record) = match public_document(&state, &token).await {
        Ok(value) => value,
        Err(response) if response.status() == StatusCode::NOT_FOUND => {
            return html_response(StatusCode::NOT_FOUND, &nonce, link_off_page(&nonce));
        }
        Err(response) => return response,
    };
    let source = match document_source(&state, &record).await {
        Ok(source) => source,
        Err(response) => return response,
    };
    let input = PageInput {
        token: &token,
        record: &record,
        source: &source,
    };
    html_response(StatusCode::OK, &nonce, document_page(&input, &nonce))
}

/// `GET /d/:token/raw`
pub(crate) async fn raw(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Response {
    if let Err(response) = observe_public(
        &rate_limiter,
        &headers,
        connect_info.as_ref(),
        PublicAccess::Read,
    )
    .await
    {
        return response;
    }
    match public_document(&state, &token).await {
        Ok((_, record)) => raw_html_response(&state, &record).await,
        Err(response) => response,
    }
}
