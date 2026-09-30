//! Serves HTML and SVG artifact previews from a dedicated URI scheme.
//!
//! A `srcdoc` frame inherits the app window's Content-Security-Policy, which
//! allows scripts and styles only from the app bundle. The inspector therefore
//! registers each preview document here and loads it from
//! `kordi-artifact-preview:` instead. That response carries its own policy:
//! the preview can use inline and HTTPS scripts, styles, fonts, and forms like
//! an ordinary web page, while it cannot load app, IPC, or plain-HTTP
//! (including loopback) resources. The policy also sandboxes the document, so
//! it keeps an opaque origin even outside the inspector's sandboxed frame.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// Must match `ARTIFACT_PREVIEW_SCHEME` in `src/pages/artifactPreviewFrame.tsx`.
pub const ARTIFACT_PREVIEW_SCHEME: &str = "kordi-artifact-preview";

/// Only the main window shows the artifact inspector.
const PREVIEW_WEBVIEW_LABEL: &str = "main";

/// Artifact previews are read with a 64 KiB limit; this leaves room for the
/// layout styles the inspector adds around a document.
const MAX_PREVIEW_DOCUMENT_BYTES: usize = 512 * 1024;

/// Open previews (panel, rail, and window) stay well below this count, so the
/// oldest document is only dropped after it is no longer shown.
const MAX_PREVIEW_DOCUMENTS: usize = 32;

/// Policy for preview documents. Once the document's own inline scripts run,
/// allowing `eval` adds no capability, so it stays enabled for pages built
/// with libraries that compile templates at runtime.
pub const ARTIFACT_PREVIEW_CSP: &str = concat!(
    "default-src 'none'; ",
    "script-src 'unsafe-inline' 'unsafe-eval' https:; ",
    "style-src 'unsafe-inline' https:; ",
    "img-src data: blob: https:; ",
    "font-src data: https:; ",
    "media-src data: blob: https:; ",
    "connect-src https: wss:; ",
    "worker-src blob:; ",
    "frame-src https:; ",
    "form-action https:; ",
    "base-uri 'none'; ",
    "object-src 'none'; ",
    "sandbox allow-forms allow-popups allow-scripts"
);

type StoredDocuments = VecDeque<(String, Arc<[u8]>)>;

/// Preview documents registered by the inspector, oldest first.
#[derive(Default)]
pub struct ArtifactPreviewDocuments {
    documents: Mutex<StoredDocuments>,
}

impl ArtifactPreviewDocuments {
    fn lock(&self) -> MutexGuard<'_, StoredDocuments> {
        self.documents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stores `source` and returns the unguessable token that loads it.
    pub fn open(&self, source: String) -> Result<String, String> {
        if source.len() > MAX_PREVIEW_DOCUMENT_BYTES {
            return Err("This artifact is too large to preview here.".to_string());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut documents = self.lock();
        while documents.len() >= MAX_PREVIEW_DOCUMENTS {
            documents.pop_front();
        }
        documents.push_back((token.clone(), Arc::from(source.into_bytes())));
        Ok(token)
    }

    pub fn close(&self, token: &str) {
        self.lock().retain(|(stored, _)| stored != token);
    }

    fn get(&self, token: &str) -> Option<Arc<[u8]>> {
        self.lock()
            .iter()
            .find(|(stored, _)| stored == token)
            .map(|(_, document)| Arc::clone(document))
    }
}

fn is_preview_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn preview_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, ARTIFACT_PREVIEW_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn preview_error(status: StatusCode) -> Response<Vec<u8>> {
    let reason = status.canonical_reason().unwrap_or("Error");
    preview_response(
        status,
        "text/plain; charset=utf-8",
        reason.as_bytes().to_vec(),
    )
}

/// Answers a `kordi-artifact-preview:` request made by the webview `webview_label`.
pub fn artifact_preview_response(
    documents: &ArtifactPreviewDocuments,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if webview_label != PREVIEW_WEBVIEW_LABEL {
        return preview_error(StatusCode::FORBIDDEN);
    }
    if request.method() != Method::GET {
        return preview_error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let token = request.uri().path().trim_start_matches('/');
    if !is_preview_token(token) {
        return preview_error(StatusCode::NOT_FOUND);
    }
    match documents.get(token) {
        Some(document) => preview_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            document.to_vec(),
        ),
        None => preview_error(StatusCode::NOT_FOUND),
    }
}

/// Protocol handler registered for [`ARTIFACT_PREVIEW_SCHEME`].
pub fn handle_artifact_preview_request<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let response = match context.app_handle().try_state::<ArtifactPreviewDocuments>() {
        Some(documents) => artifact_preview_response(&documents, context.webview_label(), &request),
        None => preview_error(StatusCode::NOT_FOUND),
    };
    responder.respond(response);
}

/// Registers an HTML or SVG preview document and returns its token.
#[tauri::command]
pub fn desktop_artifact_preview_document_open<R: Runtime>(
    webview: tauri::Webview<R>,
    documents: tauri::State<'_, ArtifactPreviewDocuments>,
    source: String,
) -> Result<String, String> {
    if webview.label() != PREVIEW_WEBVIEW_LABEL {
        return Err("Artifact previews are only available in the main window.".to_string());
    }
    documents.open(source)
}

/// Forgets a preview document once the inspector no longer shows it.
#[tauri::command]
pub fn desktop_artifact_preview_document_close(
    documents: tauri::State<'_, ArtifactPreviewDocuments>,
    token: String,
) {
    documents.close(&token);
}

#[cfg(test)]
mod tests;
