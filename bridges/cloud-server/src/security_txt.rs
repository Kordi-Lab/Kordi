//! RFC 9116 security contact published at `/.well-known/security.txt`.
//!
//! The document is static and is served unchanged on every public product
//! host, so each host that serves it is listed as a `Canonical` URI.
//!
//! Renew `Expires` at least 30 days before it lapses, with a date less than
//! one year ahead as RFC 9116 recommends. The default tests check only the
//! format and the one-year bound, so they never start failing as time passes.
//! Check the renewal window with
//! `cargo test -p kordi-cloud-server security_txt -- --ignored`, or probe the
//! deployed file.

use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};

pub const PATH: &str = "/.well-known/security.txt";

pub const BODY: &str = "\
Contact: https://github.com/Kordi-Lab/Kordi/security/advisories/new
Expires: 2027-08-31T00:00:00Z
Policy: https://github.com/Kordi-Lab/Kordi/blob/main/SECURITY.md
Preferred-Languages: en
Canonical: https://kordi.ai/.well-known/security.txt
Canonical: https://www.kordi.ai/.well-known/security.txt
";

const CACHE_CONTROL: &str = "public, max-age=86400";

pub(crate) async fn security_txt() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static(CACHE_CONTROL),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        BODY,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use chrono::{DateTime, Duration, Utc};
    use http_body_util::BodyExt;
    use sqlx_postgres::PgPoolOptions;
    use tower::ServiceExt;

    use super::*;
    use crate::events::EventBus;
    use crate::server::{router, ServerState};

    /// Public hosts that serve the product site, as listed in
    /// `deploy/Caddyfile.snippet`. Each one must appear as a `Canonical` URI.
    const PUBLIC_HOSTS: [&str; 2] = ["kordi.ai", "www.kordi.ai"];
    const RENEWAL_NOTICE_DAYS: i64 = 30;
    const MAX_EXPIRY_DAYS: i64 = 366;

    fn production_router() -> axum::Router {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
            .unwrap();
        router(Arc::new(ServerState::new(pool, EventBus::noop())))
    }

    async fn send(method: Method, uri: &str) -> Response {
        production_router()
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

    fn fields() -> Vec<(&'static str, &'static str)> {
        BODY.lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.split_once(": ").expect("field separator"))
            .collect()
    }

    fn values(name: &str) -> Vec<&'static str> {
        fields()
            .into_iter()
            .filter(|(field, _)| field.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
            .collect()
    }

    #[tokio::test]
    async fn public_router_serves_security_contact_as_plain_text() {
        let response = send(Method::GET, PATH).await;

        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CACHE_CONTROL], CACHE_CONTROL);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, BODY.as_bytes());
    }

    #[tokio::test]
    async fn head_request_returns_headers_without_body() {
        let response = send(Method::HEAD, PATH).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn security_contact_is_read_only() {
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            let response = send(method.clone(), PATH).await;
            assert_eq!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} must not be accepted"
            );
        }
    }

    #[tokio::test]
    async fn other_well_known_paths_are_not_served() {
        for uri in [
            "/.well-known/",
            "/.well-known/security.txt/extra",
            "/.well-known/security",
            "/security.txt",
        ] {
            let response = send(Method::GET, uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[test]
    fn security_contact_declares_rfc9116_fields() {
        assert!(BODY.ends_with('\n'));
        assert!(!BODY.contains('\r'));
        assert!(BODY.is_ascii());

        let contacts = values("Contact");
        assert!(!contacts.is_empty(), "Contact is required");
        assert!(contacts.iter().all(|value| value.starts_with("https://")));
        assert!(contacts.contains(&"https://github.com/Kordi-Lab/Kordi/security/advisories/new"));

        assert_eq!(values("Expires").len(), 1, "Expires must appear once");
        let expected_canonical: Vec<String> = PUBLIC_HOSTS
            .iter()
            .map(|host| format!("https://{host}{PATH}"))
            .collect();
        assert_eq!(values("Canonical"), expected_canonical);
        assert_eq!(
            values("Policy"),
            vec!["https://github.com/Kordi-Lab/Kordi/blob/main/SECURITY.md"]
        );
        assert_eq!(values("Preferred-Languages"), vec!["en"]);

        let known = [
            "Contact",
            "Expires",
            "Policy",
            "Preferred-Languages",
            "Canonical",
        ];
        for (field, _) in fields() {
            assert!(known.contains(&field), "unexpected field {field}");
        }
    }

    fn expires() -> DateTime<Utc> {
        let expires = values("Expires");
        assert_eq!(expires.len(), 1, "Expires must appear once");
        assert!(
            expires[0].ends_with('Z'),
            "Expires must be written in UTC: {}",
            expires[0]
        );
        DateTime::parse_from_rfc3339(expires[0])
            .expect("Expires must be an RFC 3339 timestamp")
            .with_timezone(&Utc)
    }

    #[test]
    fn security_contact_expiry_is_rfc3339_and_under_one_year() {
        let expires = expires();

        // Only an upper bound: this can fail when Expires is set too far
        // ahead, but it cannot start failing as the date approaches.
        assert!(
            expires - Utc::now() <= Duration::days(MAX_EXPIRY_DAYS),
            "security.txt Expires ({expires}) must be less than one year ahead"
        );
    }

    #[test]
    #[ignore = "date-dependent renewal reminder; run with --ignored before a release or on a schedule"]
    fn security_contact_expiry_leaves_renewal_notice() {
        let expires = expires();

        assert!(
            expires - Utc::now() >= Duration::days(RENEWAL_NOTICE_DAYS),
            "security.txt Expires ({expires}) is within {RENEWAL_NOTICE_DAYS} days; \
             publish a renewed date less than one year ahead"
        );
    }
}
