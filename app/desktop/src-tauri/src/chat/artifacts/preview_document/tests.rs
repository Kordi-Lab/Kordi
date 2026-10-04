use std::collections::HashMap;

use tauri::http::{header, Method, Request, StatusCode};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;

use super::*;

fn preview_request(path: &str) -> Request<Vec<u8>> {
    Request::builder()
        .method(Method::GET)
        .uri(format!("{ARTIFACT_PREVIEW_SCHEME}://localhost/{path}"))
        .body(Vec::new())
        .unwrap()
}

fn directives(policy: &str) -> HashMap<String, Vec<String>> {
    policy
        .split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty())
        .map(|directive| {
            let mut parts = directive.split_whitespace().map(str::to_string);
            let name = parts.next().expect("directive name");
            (name, parts.collect())
        })
        .collect()
}

fn header_value(response: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

#[test]
fn serves_registered_documents_with_their_own_policy() {
    let documents = ArtifactPreviewDocuments::default();
    let source = "<script>document.title = 'ready'</script><h1>Chart</h1>";
    let token = documents.open(source.to_string()).unwrap();

    let response = artifact_preview_response(&documents, "main", &preview_request(&token));

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), source.as_bytes());
    assert_eq!(
        header_value(&response, header::CONTENT_TYPE),
        "text/html; charset=utf-8"
    );
    assert_eq!(
        header_value(&response, header::CONTENT_SECURITY_POLICY),
        ARTIFACT_PREVIEW_CSP
    );
    assert_eq!(header_value(&response, header::CACHE_CONTROL), "no-store");
    assert_eq!(
        header_value(&response, header::X_CONTENT_TYPE_OPTIONS),
        "nosniff"
    );
}

#[test]
fn preview_policy_allows_web_page_resources_but_not_local_ones() {
    let policy = directives(ARTIFACT_PREVIEW_CSP);
    let sources = |name: &str| {
        policy
            .get(name)
            .unwrap_or_else(|| panic!("missing {name} directive"))
    };

    // Agent-written pages commonly use inline scripts, CDN libraries, CDN
    // styles and web fonts, and form posts.
    for (directive, required) in [
        ("script-src", "'unsafe-inline'"),
        ("script-src", "https:"),
        ("style-src", "'unsafe-inline'"),
        ("style-src", "https:"),
        ("font-src", "https:"),
        ("font-src", "data:"),
        ("img-src", "https:"),
        ("img-src", "data:"),
        ("connect-src", "https:"),
        ("form-action", "https:"),
    ] {
        assert!(
            sources(directive).iter().any(|value| value == required),
            "{directive} needs {required}"
        );
    }

    assert_eq!(sources("default-src"), &["'none'"]);
    assert_eq!(sources("object-src"), &["'none'"]);
    assert_eq!(sources("base-uri"), &["'none'"]);
    // The document keeps an opaque origin even if it is ever loaded outside
    // the inspector's sandboxed frame.
    assert_eq!(
        sources("sandbox"),
        &["allow-forms", "allow-popups", "allow-scripts"]
    );

    for (name, values) in &policy {
        for value in values {
            for local in [
                "*",
                "http:",
                "ws:",
                "'self'",
                "tauri:",
                "ipc:",
                "asset:",
                "localhost",
                "127.0.0.1",
                "allow-same-origin",
                "allow-top-navigation",
            ] {
                assert!(
                    !value.contains(local),
                    "{name} must not allow {local}: {value}"
                );
            }
        }
    }
}

#[test]
fn rejects_other_windows_methods_and_unknown_tokens() {
    let documents = ArtifactPreviewDocuments::default();
    let token = documents.open("<p>ok</p>".to_string()).unwrap();

    for label in ["auth-popup", "media-preview", "call"] {
        let response = artifact_preview_response(&documents, label, &preview_request(&token));
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{label}");
        assert!(response.body() != b"<p>ok</p>");
    }

    let post = Request::builder()
        .method(Method::POST)
        .uri(format!("{ARTIFACT_PREVIEW_SCHEME}://localhost/{token}"))
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        artifact_preview_response(&documents, "main", &post).status(),
        StatusCode::METHOD_NOT_ALLOWED
    );

    for path in [
        String::new(),
        "index.html".to_string(),
        "../etc/passwd".to_string(),
        token.to_uppercase(),
        format!("{token}/style.css"),
        uuid::Uuid::new_v4().simple().to_string(),
    ] {
        let response = artifact_preview_response(&documents, "main", &preview_request(&path));
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        // Error responses still carry the preview policy.
        assert_eq!(
            header_value(&response, header::CONTENT_SECURITY_POLICY),
            ARTIFACT_PREVIEW_CSP
        );
    }
}

#[test]
fn windows_style_urls_resolve_to_the_same_document() {
    let documents = ArtifactPreviewDocuments::default();
    let token = documents.open("<p>ok</p>".to_string()).unwrap();
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "http://{ARTIFACT_PREVIEW_SCHEME}.localhost/{token}"
        ))
        .body(Vec::new())
        .unwrap();

    let response = artifact_preview_response(&documents, "main", &request);

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"<p>ok</p>");
}

#[test]
fn closed_evicted_and_oversized_documents_are_not_served() {
    let documents = ArtifactPreviewDocuments::default();
    let closed = documents.open("<p>closed</p>".to_string()).unwrap();
    documents.close(&closed);
    assert_eq!(
        artifact_preview_response(&documents, "main", &preview_request(&closed)).status(),
        StatusCode::NOT_FOUND
    );

    let first = documents.open("<p>first</p>".to_string()).unwrap();
    let mut latest = String::new();
    for index in 0..MAX_PREVIEW_DOCUMENTS {
        latest = documents.open(format!("<p>{index}</p>")).unwrap();
    }
    assert_eq!(
        artifact_preview_response(&documents, "main", &preview_request(&first)).status(),
        StatusCode::NOT_FOUND,
        "the oldest document is dropped once the limit is reached"
    );
    assert_eq!(
        artifact_preview_response(&documents, "main", &preview_request(&latest)).status(),
        StatusCode::OK
    );

    assert!(documents
        .open("x".repeat(MAX_PREVIEW_DOCUMENT_BYTES + 1))
        .is_err());
}

#[test]
fn tokens_are_unique_and_unguessable() {
    let documents = ArtifactPreviewDocuments::default();
    let first = documents.open(String::new()).unwrap();
    let second = documents.open(String::new()).unwrap();
    assert_ne!(first, second);
    assert!(is_preview_token(&first) && is_preview_token(&second));
}

fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize().unwrap_or(serde_json::Value::Null))
    .map_err(|error| error.to_string())
}

#[test]
fn only_the_main_window_registers_preview_documents() {
    let app = mock_builder()
        .manage(ArtifactPreviewDocuments::default())
        .invoke_handler(tauri::generate_handler![
            desktop_artifact_preview_document_open,
            desktop_artifact_preview_document_close
        ])
        .build(mock_context(noop_assets()))
        .expect("build app");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let call = tauri::WebviewWindowBuilder::new(&app, "call", Default::default())
        .build()
        .unwrap();

    let denied = invoke(
        &call,
        "desktop_artifact_preview_document_open",
        serde_json::json!({ "source": "<p>call</p>" }),
    );
    assert!(denied.is_err(), "{denied:?}");

    let token = invoke(
        &main,
        "desktop_artifact_preview_document_open",
        serde_json::json!({ "source": "<p>main</p>" }),
    )
    .expect("main window registers previews");
    let token = token.as_str().expect("token string").to_string();
    let documents = app.state::<ArtifactPreviewDocuments>();
    assert_eq!(
        artifact_preview_response(&documents, "main", &preview_request(&token)).body(),
        b"<p>main</p>"
    );

    invoke(
        &main,
        "desktop_artifact_preview_document_close",
        serde_json::json!({ "token": token }),
    )
    .expect("close");
    assert_eq!(
        artifact_preview_response(&documents, "main", &preview_request(&token)).status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn the_app_policy_frames_only_app_and_preview_documents() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../../tauri.conf.json")).expect("tauri config");
    let frame_sources: Vec<&str> = config
        .pointer("/app/security/csp/frame-src")
        .and_then(serde_json::Value::as_array)
        .expect("frame-src")
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();

    for required in [
        format!("{ARTIFACT_PREVIEW_SCHEME}:"),
        format!("http://{ARTIFACT_PREVIEW_SCHEME}.localhost"),
    ] {
        assert!(
            frame_sources.contains(&required.as_str()),
            "frame-src needs {required}"
        );
    }
    for source in &frame_sources {
        assert!(
            !matches!(*source, "*" | "https:" | "http:" | "data:" | "blob:"),
            "the main window must not frame arbitrary documents: {source}"
        );
    }
}
