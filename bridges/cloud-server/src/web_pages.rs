//! Optional same-origin web pages for account sign-in.
//!
//! The web sign-in session lives in a host-only `HttpOnly` cookie, so the
//! pages that use it must be served from the API origin. When
//! `KORDI_WEB_PAGES_DIR` names a directory, the server serves its pages at the
//! account routes and its static assets. When it is unset, no route is added.
//!
//! Pages use clean URLs: `/login` serves `login.html` (or `login/index.html`),
//! and `/account/security` serves `account/security.html`. Other files are
//! served only when their extension is a known static asset type. Paths may
//! contain only ASCII letters, digits, `-`, `_` and `.`, no segment may start
//! with `.`, and the resolved file must stay inside the directory after
//! following symbolic links. Directories are never listed.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::extract::{OriginalUri, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::auth::app_sign_in::APP_SIGN_IN_PAGE_PATH;

pub const WEB_PAGES_DIR_ENV: &str = "KORDI_WEB_PAGES_DIR";

/// The path the default app sign-in page resolves to when pages are served.
pub const LOGIN_PAGE_PATH: &str = "/login";

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const PAGE_CACHE_CONTROL: &str = "no-cache";
const ASSET_CACHE_CONTROL: &str = "public, max-age=3600";

/// A validated directory of web pages.
#[derive(Clone, Debug)]
pub struct WebPagesDir {
    root: Arc<PathBuf>,
}

impl WebPagesDir {
    /// Open a directory of pages. The path must exist and be a directory.
    pub fn open(path: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(path)
            .map_err(|_| format!("{WEB_PAGES_DIR_ENV} must name an existing directory"))?;
        if !root.is_dir() {
            return Err(format!("{WEB_PAGES_DIR_ENV} must name a directory"));
        }
        Ok(Self {
            root: Arc::new(root),
        })
    }

    /// Read `KORDI_WEB_PAGES_DIR`. Unset or empty means no pages.
    pub fn from_env() -> Result<Option<Self>, String> {
        match std::env::var(WEB_PAGES_DIR_ENV) {
            Ok(value) if !value.trim().is_empty() => Self::open(Path::new(value.trim())).map(Some),
            _ => Ok(None),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Routes for the configured pages, or no routes when `pages` is `None`.
pub fn routes(pages: Option<WebPagesDir>) -> Router {
    let Some(pages) = pages else {
        return Router::new();
    };
    Router::new()
        .route(APP_SIGN_IN_PAGE_PATH, get(app_sign_in_page))
        .route("/login", get(page))
        .route("/login/done", get(page))
        .route("/register", get(page))
        .route("/account", get(page))
        .route("/account/*rest", get(page))
        .fallback(asset)
        .with_state(pages)
}

/// Routes from the environment. A set but invalid directory serves nothing;
/// the binary checks the setting at startup and refuses to start instead.
pub fn routes_from_env() -> Router {
    routes(WebPagesDir::from_env().unwrap_or_else(|err| {
        eprintln!("[web-pages] disabled: {err}");
        None
    }))
}

/// `GET /sign-in/app`: the served login page, with the query preserved.
async fn app_sign_in_page(OriginalUri(uri): OriginalUri) -> Response {
    let location = match uri.query() {
        Some(query) => format!("{LOGIN_PAGE_PATH}?{query}"),
        None => LOGIN_PAGE_PATH.to_string(),
    };
    let Ok(location) = HeaderValue::from_str(&location) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, location),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response()
}

async fn page(
    State(pages): State<WebPagesDir>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let Some(segments) = clean_segments(uri.path()) else {
        return not_found();
    };
    if let Some(kind) = segments.last().and_then(|name| asset_type(name)) {
        return serve(&pages, &segments.join("/"), kind, &headers).await;
    }
    let base = segments.join("/");
    for candidate in [format!("{base}.html"), format!("{base}/index.html")] {
        if let Some(file) = resolve(&pages, &candidate).await {
            return respond(file, HTML, &headers).await;
        }
    }
    not_found()
}

async fn asset(
    State(pages): State<WebPagesDir>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    let Some(segments) = clean_segments(uri.path()) else {
        return not_found();
    };
    if matches!(segments.first().map(String::as_str), Some("v1" | "v2")) {
        return not_found();
    }
    match segments.last().and_then(|name| asset_type(name)) {
        Some(kind) => serve(&pages, &segments.join("/"), kind, &headers).await,
        None => not_found(),
    }
}

/// Split a request path into safe segments, or `None` for any path that
/// could leave the directory or name a hidden file.
pub(crate) fn clean_segments(path: &str) -> Option<Vec<String>> {
    let rest = path.strip_prefix('/')?;
    let segments: Vec<String> = rest.split('/').map(str::to_string).collect();
    let safe = |segment: &String| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    segments.iter().all(safe).then_some(segments)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ContentKind {
    content_type: &'static str,
    page: bool,
}

const HTML: ContentKind = ContentKind {
    content_type: "text/html; charset=utf-8",
    page: true,
};

const fn asset_kind(content_type: &'static str) -> ContentKind {
    ContentKind {
        content_type,
        page: false,
    }
}

/// The content type of a static asset by extension. HTML is served only
/// through page routes, so it is not an asset type.
pub(crate) fn asset_type(name: &str) -> Option<ContentKind> {
    let (_, extension) = name.rsplit_once('.')?;
    let content_type = match extension.to_ascii_lowercase().as_str() {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    };
    Some(asset_kind(content_type))
}

async fn serve(
    pages: &WebPagesDir,
    relative: &str,
    kind: ContentKind,
    headers: &HeaderMap,
) -> Response {
    match resolve(pages, relative).await {
        Some(file) => respond(file, kind, headers).await,
        None => not_found(),
    }
}

/// A regular file inside the directory, after following symbolic links.
async fn resolve(pages: &WebPagesDir, relative: &str) -> Option<PathBuf> {
    let path = tokio::fs::canonicalize(pages.root().join(relative))
        .await
        .ok()?;
    if !path.starts_with(pages.root()) {
        return None;
    }
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    (metadata.is_file() && metadata.len() <= MAX_FILE_BYTES).then_some(path)
}

async fn respond(path: PathBuf, kind: ContentKind, headers: &HeaderMap) -> Response {
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return not_found();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    let etag = format!("W/\"{:x}-{:x}\"", metadata.len(), modified);
    let mut response = if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag))
    {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        match tokio::fs::read(&path).await {
            Ok(body) => (
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(kind.content_type),
                )],
                body,
            )
                .into_response(),
            Err(_) => return not_found(),
        }
    };
    let response_headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        response_headers.insert(header::ETAG, value);
    }
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if kind.page {
        response_headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(PAGE_CACHE_CONTROL),
        );
        // Sign-in pages must not be framed (the display-code confirmation is
        // a click target) and must not leak their query to other sites.
        response_headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
        response_headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
        response_headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
    } else {
        response_headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(ASSET_CACHE_CONTROL),
        );
    }
    response
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

#[cfg(test)]
mod tests;
