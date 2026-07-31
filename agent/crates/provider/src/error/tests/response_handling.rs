//! Live HTTP response bounding, timeout, and HTML short-circuit scenarios.

use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn live_response_parser_bounds_html_and_preserves_safe_diagnostics() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let body = format!(
        "<html><svg d=\"M 0.500197 0.495044\"></svg><p>[IP:203.0.113.1]</p>{}</html>",
        "x".repeat(MAX_ERROR_BODY_BYTES * 2)
    );
    let response_bytes = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=utf-8\r\nCF-Ray: ray-test-HKG\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 2_048];
        let _ = stream.read(&mut request).await.unwrap();
        stream.write_all(response_bytes.as_bytes()).await.unwrap();
    });

    let url = format!(
        "http://user:password@{address}/backend-api/codex/responses?access_token=secret#fragment"
    );
    let response = reqwest::get(&url).await.unwrap();
    let error = unexpected_response(
        "openai",
        "responses request",
        ProviderErrorFormat::OpenAi,
        response,
    )
    .await;
    server.await.unwrap();

    let ProviderError::Http(error) = error else {
        panic!("expected an HTTP provider error");
    };
    let rendered = error.to_string();
    assert_eq!(
        error.content_type.as_deref(),
        Some("text/html; charset=utf-8")
    );
    assert!(error.body_truncated);
    assert!(error.cloudflare_block);
    assert_eq!(error.cf_ray.as_deref(), Some("ray-test-HKG"));
    assert!(rendered.contains("unexpected status 403 Forbidden: Unknown error"));
    assert!(rendered.contains("cf-ray: ray-test-HKG"));
    assert!(!rendered.contains("secret"));
    assert!(!rendered.contains("password"));
    assert!(!rendered.contains("203.0.113.1"));
    assert!(!rendered.contains("<html"));
    assert!(!error.is_retryable());
}

#[tokio::test]
async fn terminal_error_body_read_has_a_total_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 2_048];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"error\":",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let response = reqwest::get(format!("http://{address}/slow-error"))
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    let error = unexpected_response(
        "openai",
        "responses request",
        ProviderErrorFormat::OpenAi,
        response,
    )
    .await;
    let elapsed = started.elapsed();
    server.abort();

    let ProviderError::Http(error) = error else {
        panic!("expected an HTTP provider error");
    };
    assert!(error.body_truncated);
    assert_eq!(error.message, "Unknown error");
    assert!(
        elapsed >= MAX_ERROR_BODY_READ_DURATION
            && elapsed < MAX_ERROR_BODY_READ_DURATION + Duration::from_secs(3),
        "bounded read took {elapsed:?}"
    );
    assert!(!error.is_retryable());
}

#[tokio::test]
async fn declared_html_error_does_not_wait_for_the_upstream_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 2_048];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nCF-Ray: ray-slow-HKG\r\nContent-Length: 128\r\nConnection: close\r\n\r\n<html>",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let response = reqwest::get(format!("http://{address}/slow-html"))
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    let error = unexpected_response(
        "openai",
        "responses request",
        ProviderErrorFormat::OpenAi,
        response,
    )
    .await;
    let elapsed = started.elapsed();
    server.abort();

    let ProviderError::Http(error) = error else {
        panic!("expected an HTTP provider error");
    };
    assert_eq!(error.message, "Unknown error");
    assert!(error.body_truncated);
    assert!(error.cloudflare_block);
    assert!(
        elapsed < Duration::from_secs(1),
        "HTML error body should not be read, took {elapsed:?}"
    );
    assert!(!error.is_retryable());
}
