use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

/// A temporary pages directory, removed on drop.
struct Fixture {
    base: PathBuf,
    pages: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "kordi-web-pages-test-{}",
            crate::auth::session::random_token_plaintext()
        ));
        let pages = base.join("pages");
        for (path, body) in [
            ("login.html", "<p>login</p>"),
            ("register.html", "<p>register</p>"),
            ("login/done.html", "<p>done</p>"),
            ("account/index.html", "<p>account</p>"),
            ("account/security.html", "<p>security</p>"),
            ("privacy.html", "<p>privacy</p>"),
            ("assets/public/account.css", "body {}"),
            ("assets/public/account.js", "void 0;"),
            ("assets/logo.svg", "<svg/>"),
            ("assets/.hidden.css", "hidden"),
            ("notes.sql", "select 1;"),
        ] {
            let file = pages.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, body).unwrap();
        }
        std::fs::write(base.join("secret.css"), "outside").unwrap();
        Self { base, pages }
    }

    fn router(&self) -> Router {
        routes(Some(WebPagesDir::open(&self.pages).unwrap()))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

async fn request(router: &Router, method: Method, uri: &str) -> Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn get_body(router: &Router, uri: &str) -> (StatusCode, HeaderMap, String) {
    let response = request(router, Method::GET, uri).await;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

fn header_value(headers: &HeaderMap, name: header::HeaderName) -> &str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

#[tokio::test]
async fn account_routes_serve_clean_url_pages() {
    let fixture = Fixture::new();
    let router = fixture.router();
    for (uri, body) in [
        ("/login", "<p>login</p>"),
        ("/login?client_id=kordi-desktop&state=abc", "<p>login</p>"),
        ("/register", "<p>register</p>"),
        ("/login/done", "<p>done</p>"),
        ("/account", "<p>account</p>"),
        ("/account/security", "<p>security</p>"),
    ] {
        let (status, headers, text) = get_body(&router, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(text, body, "{uri}");
        assert_eq!(
            header_value(&headers, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
        assert_eq!(header_value(&headers, header::CACHE_CONTROL), "no-cache");
        assert_eq!(header_value(&headers, header::X_FRAME_OPTIONS), "DENY");
        assert_eq!(
            header_value(&headers, header::CONTENT_SECURITY_POLICY),
            "frame-ancestors 'none'"
        );
        assert_eq!(
            header_value(&headers, header::REFERRER_POLICY),
            "no-referrer"
        );
        assert_eq!(
            header_value(&headers, header::X_CONTENT_TYPE_OPTIONS),
            "nosniff"
        );
    }
}

#[tokio::test]
async fn assets_are_served_with_their_content_type() {
    let fixture = Fixture::new();
    let router = fixture.router();
    for (uri, content_type) in [
        ("/assets/public/account.css", "text/css; charset=utf-8"),
        (
            "/assets/public/account.js",
            "text/javascript; charset=utf-8",
        ),
        ("/assets/logo.svg", "image/svg+xml"),
    ] {
        let (status, headers, _) = get_body(&router, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(header_value(&headers, header::CONTENT_TYPE), content_type);
        assert_eq!(
            header_value(&headers, header::CACHE_CONTROL),
            "public, max-age=3600"
        );
        assert_eq!(
            header_value(&headers, header::X_CONTENT_TYPE_OPTIONS),
            "nosniff"
        );
    }
}

#[tokio::test]
async fn unsafe_and_unknown_paths_are_not_served() {
    let fixture = Fixture::new();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        fixture.base.join("secret.css"),
        fixture.pages.join("assets/linked.css"),
    )
    .unwrap();
    let router = fixture.router();
    for uri in [
        "/assets/../../secret.css",
        "/assets/%2e%2e/%2e%2e/secret.css",
        "/assets/..%2f..%2fsecret.css",
        "/account/..",
        "/account/../privacy",
        "/assets/.hidden.css",
        "/.hidden.css",
        "/assets/linked.css",
        "/assets",
        "/assets/",
        "/account/",
        "/assets//logo.svg",
        "/privacy.html",
        "/privacy",
        "/login.html",
        "/notes.sql",
        "/assets/missing.css",
        "/v1/assets/logo.svg",
        "/v2/assets/logo.svg",
    ] {
        let (status, _, body) = get_body(&router, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert!(body.is_empty(), "{uri}");
    }
    let response = request(&router, Method::POST, "/assets/logo.svg").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn head_and_conditional_requests_work() {
    let fixture = Fixture::new();
    let router = fixture.router();
    let response = request(&router, Method::HEAD, "/login").await;
    assert_eq!(response.status(), StatusCode::OK);
    let etag = header_value(response.headers(), header::ETAG).to_string();
    assert!(etag.starts_with("W/\""), "{etag}");

    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/login")
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(header_value(response.headers(), header::ETAG), etag);
}

#[tokio::test]
async fn app_sign_in_page_resolves_to_login_with_its_query() {
    let fixture = Fixture::new();
    let router = fixture.router();
    let response = request(
        &router,
        Method::GET,
        "/sign-in/app?response_type=code&client_id=kordi-desktop&state=s%20t",
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        header_value(response.headers(), header::LOCATION),
        "/login?response_type=code&client_id=kordi-desktop&state=s%20t"
    );
    assert_eq!(
        header_value(response.headers(), header::CACHE_CONTROL),
        "no-store"
    );

    let response = request(&router, Method::GET, "/sign-in/app").await;
    assert_eq!(header_value(response.headers(), header::LOCATION), "/login");
}

#[tokio::test]
async fn nothing_is_served_without_a_directory() {
    let router = routes(None);
    for uri in ["/login", "/sign-in/app?state=x", "/assets/logo.svg"] {
        let response = request(&router, Method::GET, uri).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }
}

#[test]
fn opening_requires_an_existing_directory() {
    let fixture = Fixture::new();
    assert!(WebPagesDir::open(&fixture.pages).is_ok());
    assert!(WebPagesDir::open(&fixture.pages.join("login.html")).is_err());
    assert!(WebPagesDir::open(&fixture.base.join("missing")).is_err());
}

#[test]
fn segments_reject_traversal_and_hidden_names() {
    assert_eq!(
        clean_segments("/account/security"),
        Some(vec!["account".to_string(), "security".to_string()])
    );
    for path in [
        "", "/", "//x", "/a/../b", "/./a", "/.env", "/a%2fb", "/a\\b", "/a b", "/a/",
    ] {
        assert_eq!(clean_segments(path), None, "{path}");
    }
    assert!(asset_type("login.html").is_none());
    assert!(asset_type("archive.tar").is_none());
    assert!(asset_type("noextension").is_none());
    assert_eq!(
        asset_type("FONT.WOFF2").map(|kind| kind.content_type),
        Some("font/woff2")
    );
}

#[tokio::test]
async fn merged_pages_leave_api_routes_unchanged() {
    let fixture = Fixture::new();
    let router = Router::new()
        .route("/v1/cloud/ping", get(|| async { "pong" }))
        .merge(fixture.router())
        .layer(tower_http::cors::CorsLayer::new());
    let (status, _, body) = get_body(&router, "/v1/cloud/ping").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"));
    let response = request(&router, Method::POST, "/v1/cloud/ping").await;
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    for uri in ["/v1/cloud/missing", "/v1/cloud/missing.js"] {
        let response = request(&router, Method::GET, uri).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    let (status, _, body) = get_body(&router, "/login").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "<p>login</p>"));
}
