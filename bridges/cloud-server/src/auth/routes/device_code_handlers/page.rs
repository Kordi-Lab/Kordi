//! The approval page at `/device`. It is built into the server so it always
//! runs on the API origin, where the web session cookie lives, and it loads
//! only its own script and stylesheet under a strict content security
//! policy. The page may not be framed, so the Approve button cannot be
//! hidden under another site.

use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

const PAGE: &str = include_str!("page/device.html");
const SCRIPT: &str = include_str!("page/device.js");
const STYLE: &str = include_str!("page/device.css");

const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self'; \
     style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; \
     form-action 'self'; frame-ancestors 'none'";

fn respond(body: &'static str, content_type: &'static str) -> Response {
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_TYPE, content_type),
        (header::CACHE_CONTROL, "no-cache"),
        (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

/// `GET /device`.
pub(in crate::auth::routes) async fn device_page() -> Response {
    respond(PAGE, "text/html; charset=utf-8")
}

/// `GET /device/:asset`: the page's script and stylesheet.
pub(in crate::auth::routes) async fn device_page_asset(Path(asset): Path<String>) -> Response {
    match asset.as_str() {
        "device.js" => respond(SCRIPT, "text/javascript; charset=utf-8"),
        "device.css" => respond(STYLE, "text/css; charset=utf-8"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::device_code::APPROVAL_WARNING;

    #[test]
    fn page_shows_the_warning_and_loads_only_its_own_files() {
        assert!(PAGE.contains(APPROVAL_WARNING));
        assert!(PAGE.contains(r#"src="/device/device.js""#));
        assert!(PAGE.contains(r#"href="/device/device.css""#));
        assert!(!PAGE.contains("<script>"));
        assert!(!PAGE.contains("style="));
        assert!(!PAGE.contains("http://") && !PAGE.contains("https://"));
        // Google and GitHub stay available on every sign-in surface.
        assert!(PAGE.contains("/v1/cloud/auth/web/oauth/google/start?returnTo=%2Fdevice"));
        assert!(PAGE.contains("/v1/cloud/auth/web/oauth/github/start?returnTo=%2Fdevice"));
        // The page never stores anything in the browser.
        assert!(!SCRIPT.contains("localStorage") && !SCRIPT.contains("document.cookie"));
    }

    #[tokio::test]
    async fn page_cannot_be_framed() {
        let response = device_page().await;
        assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'"));
        let missing = device_page_asset(Path("other.js".to_string())).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }
}
