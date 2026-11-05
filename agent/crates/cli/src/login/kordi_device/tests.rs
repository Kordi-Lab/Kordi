use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use super::*;

/// A loopback server that answers each request with the next scripted
/// response and records what it received.
fn scripted_server(
    responses: Vec<(u16, &'static str)>,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer).unwrap();
            requests.push(String::from_utf8_lossy(&buffer[..read]).to_string());
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
        requests
    });
    (address, handle)
}

const CODE: &str = r#"{"device_code":"kordi_dc_synthetic","user_code":"CDFG-HJKM","verification_uri":"https://example.test/device","expires_in":900,"interval":5}"#;
const TOKENS: &str = r#"{"access_token":"kordi_cs_synthetic","token_type":"Bearer","expires_in":3600,"refresh_token":"kordi_rt_synthetic","refresh_token_expires_in":2592000,"device_id":"dev_synthetic","sign_in_id":"asi_synthetic","account":{"accountId":"acct_synthetic"}}"#;

fn config(base_url: String) -> DeviceSignInConfig {
    DeviceSignInConfig {
        base_url,
        client_id: "kordi-desktop".to_string(),
    }
}

fn device() -> DeviceDescription {
    DeviceDescription {
        name: Some("Build Mac mini".to_string()),
        platform: Some("macos".to_string()),
        os_version: Some("26.1".to_string()),
        app_version: Some("0.0.0".to_string()),
        public_key: Some("synthetic-key".to_string()),
        key_algorithm: Some("p256".to_string()),
    }
}

#[tokio::test]
async fn polls_through_pending_and_slow_down_to_a_saved_session() {
    let (base, server) = scripted_server(vec![
        (200, CODE),
        (400, r#"{"error":"authorization_pending"}"#),
        (400, r#"{"error":"slow_down","interval":10}"#),
        (200, TOKENS),
    ]);
    let waits = Arc::new(Mutex::new(Vec::new()));
    let recorded = waits.clone();
    let shown = Arc::new(Mutex::new(None));
    let prompt_sink = shown.clone();
    let entry = device_sign_in(
        &reqwest::Client::new(),
        &config(base.clone()),
        &device(),
        |prompt| *prompt_sink.lock().unwrap() = Some(prompt.clone()),
        move |wait| {
            recorded.lock().unwrap().push(wait);
            async {}
        },
    )
    .await
    .unwrap();

    let prompt = shown.lock().unwrap().clone().unwrap();
    assert_eq!(prompt.user_code, "CDFG-HJKM");
    assert_eq!(prompt.verification_uri, "https://example.test/device");
    assert_eq!(
        *waits.lock().unwrap(),
        vec![
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(10)
        ]
    );
    assert_eq!(entry.token, "kordi_cs_synthetic");
    assert_eq!(entry.account_id, "acct_synthetic");
    assert_eq!(entry.device_id.as_deref(), Some("dev_synthetic"));
    assert_eq!(entry.refresh_token.as_deref(), Some("kordi_rt_synthetic"));
    assert_eq!(entry.client_id.as_deref(), Some("kordi-desktop"));
    assert_eq!(
        entry.token_endpoint,
        Some(format!("{base}/v1/cloud/auth/app/token"))
    );

    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("POST /v1/cloud/auth/device/code "));
    assert!(requests[0].contains("device_name=Build+Mac+mini"));
    assert!(requests[0].contains("device_public_key=synthetic-key"));
    assert!(requests[1].starts_with("POST /v1/cloud/auth/device/token "));
    assert!(
        requests[1].contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
    );
    assert!(requests[1].contains("device_code=kordi_dc_synthetic"));
}

#[tokio::test]
async fn denied_expired_and_unsupported_servers_stop_with_their_reason() {
    for (responses, expected) in [
        (
            vec![
                (200, CODE),
                (
                    400,
                    r#"{"error":"access_denied","error_description":"Your organization does not allow sign-in with a code.","reason":"organization_policy"}"#,
                ),
            ],
            DeviceSignInError::Denied(
                "Your organization does not allow sign-in with a code.".to_string(),
            ),
        ),
        (
            vec![(200, CODE), (400, r#"{"error":"expired_token"}"#)],
            DeviceSignInError::Expired,
        ),
        (
            vec![(404, r#"{"errorCode":"not_found"}"#)],
            DeviceSignInError::Unsupported,
        ),
    ] {
        let (base, server) = scripted_server(responses);
        let error = device_sign_in(
            &reqwest::Client::new(),
            &config(base),
            &device(),
            |_| {},
            |_| async {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.downcast_ref::<DeviceSignInError>(), Some(&expected));
        server.join().unwrap();
    }
}

#[test]
fn only_https_or_loopback_servers_are_accepted() {
    assert_eq!(
        allowed_base_url("https://example.test/path").unwrap(),
        "https://example.test"
    );
    assert_eq!(
        allowed_base_url("http://127.0.0.1:17301").unwrap(),
        "http://127.0.0.1:17301"
    );
    assert!(allowed_base_url("http://example.test").is_err());
    assert!(allowed_base_url("not a url").is_err());
}
