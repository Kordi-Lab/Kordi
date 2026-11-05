use super::*;
use std::io::{Read, Write};

fn entry() -> CloudSessionEntry {
    CloudSessionEntry {
        token: "kordi_cs_old".into(),
        account_id: "acct_a".into(),
        expires_at: "2026-01-01T00:00:00Z".into(),
        device_id: Some("dev_a".into()),
        refresh_token: Some("kordi_rt_a".into()),
        client_id: Some("kordi-desktop".into()),
        token_endpoint: Some("https://app.example.test/v1/cloud/auth/app/token".into()),
        organization_id: None,
    }
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

const SWITCHED: &[u8] = br#"{"access_token":"kordi_cs_team","token_type":"Bearer","expires_in":3600,"account_id":"acct_a","device_id":"dev_a","sign_in_id":"signin_a","organization_id":"org_team"}"#;

fn with_isolated_store(test: impl FnOnce()) {
    let _guard = crate::test_support::lock_process_environment();
    let previous = std::env::var_os("APP_DATA_DIR");
    let dir = std::env::temp_dir().join(format!("kordi-org-test-{}", uuid::Uuid::new_v4()));
    std::env::set_var("APP_DATA_DIR", &dir);
    test();
    let _ = std::fs::remove_dir_all(&dir);
    match previous {
        Some(value) => std::env::set_var("APP_DATA_DIR", value),
        None => std::env::remove_var("APP_DATA_DIR"),
    }
}

#[test]
fn a_switch_saves_the_new_token_and_keeps_the_refresh_token() {
    with_isolated_store(|| {
        let start = entry();
        store_session_entry(&start).unwrap();
        let next = switched_entry(&start, "org_team", 200, SWITCHED, now()).unwrap();
        let stored = store_switched_session(&start, &next).unwrap();
        assert_eq!(stored.token, "kordi_cs_team");
        let loaded = cloud_session_load().unwrap().unwrap();
        assert_eq!(loaded.token, "kordi_cs_team");
        assert_eq!(loaded.refresh_token.as_deref(), Some("kordi_rt_a"));
        assert_eq!(loaded.organization_id.as_deref(), Some("org_team"));
        assert_eq!(loaded.account_id, "acct_a");
        assert_eq!(loaded.device_id.as_deref(), Some("dev_a"));
        assert_eq!(loaded.expires_at, "2026-01-01T01:00:00Z");
    });
}

#[test]
fn a_stale_switch_never_overwrites_a_newer_sign_in_or_refresh() {
    with_isolated_store(|| {
        let start = entry();
        let next = switched_entry(&start, "org_team", 200, SWITCHED, now()).unwrap();

        // Another account signed in while the switch was in flight.
        let other = CloudSessionEntry {
            token: "kordi_cs_other".into(),
            account_id: "acct_b".into(),
            refresh_token: Some("kordi_rt_b".into()),
            ..entry()
        };
        store_session_entry(&other).unwrap();
        assert_eq!(
            store_switched_session(&start, &next).unwrap_err(),
            "session_changed"
        );
        assert_eq!(
            cloud_session_load().unwrap().unwrap().token,
            "kordi_cs_other"
        );

        // The same account signed in again, or a refresh rotated the tokens.
        let rotated = CloudSessionEntry {
            token: "kordi_cs_rotated".into(),
            refresh_token: Some("kordi_rt_rotated".into()),
            ..entry()
        };
        store_session_entry(&rotated).unwrap();
        assert_eq!(
            store_switched_session(&start, &next).unwrap_err(),
            "session_changed"
        );
        let loaded = cloud_session_load().unwrap().unwrap();
        assert_eq!(loaded.token, "kordi_cs_rotated");
        assert_eq!(loaded.refresh_token.as_deref(), Some("kordi_rt_rotated"));
        assert_eq!(loaded.organization_id, None);
    });
}

#[test]
fn a_switch_never_undoes_a_sign_out() {
    with_isolated_store(|| {
        let start = entry();
        store_session_entry(&start).unwrap();
        let next = switched_entry(&start, "org_team", 200, SWITCHED, now()).unwrap();
        crate::cloud_session::cloud_session_clear().unwrap();
        assert_eq!(
            store_switched_session(&start, &next).unwrap_err(),
            "not_signed_in"
        );
        assert!(cloud_session_load().unwrap().is_none());
    });
}

#[test]
fn a_token_only_session_switches_only_from_the_same_token() {
    with_isolated_store(|| {
        let legacy = CloudSessionEntry {
            token: "kordi_s_legacy".into(),
            refresh_token: None,
            client_id: None,
            token_endpoint: None,
            ..entry()
        };
        let body = br#"{"access_token":"kordi_s_legacy","token_type":"Bearer","expires_in":86400,"account_id":"acct_a","device_id":"dev_a","organization_id":"org_team"}"#;
        let next = switched_entry(&legacy, "org_team", 200, body, now()).unwrap();
        let replaced = CloudSessionEntry {
            token: "kordi_s_newer".into(),
            ..legacy.clone()
        };
        store_session_entry(&replaced).unwrap();
        assert_eq!(
            store_switched_session(&legacy, &next).unwrap_err(),
            "session_changed"
        );
        store_session_entry(&legacy).unwrap();
        let stored = store_switched_session(&legacy, &next).unwrap();
        assert_eq!(stored.token, "kordi_s_legacy");
        assert_eq!(stored.organization_id.as_deref(), Some("org_team"));
    });
}

#[test]
fn a_response_for_another_account_or_device_is_rejected() {
    let start = entry();
    let other_account = br#"{"access_token":"kordi_cs_x","expires_in":3600,"account_id":"acct_b","device_id":"dev_a","organization_id":"org_team"}"#;
    let other_device = br#"{"access_token":"kordi_cs_x","expires_in":3600,"account_id":"acct_a","device_id":"dev_b","organization_id":"org_team"}"#;
    let other_organization = br#"{"access_token":"kordi_cs_x","expires_in":3600,"account_id":"acct_a","device_id":"dev_a","organization_id":"org_other"}"#;
    let no_token = br#"{"account_id":"acct_a","device_id":"dev_a","organization_id":"org_team"}"#;
    for (body, code) in [
        (&other_account[..], "account_mismatch"),
        (&other_device[..], "account_mismatch"),
        (&other_organization[..], "switch_failed"),
        (&no_token[..], "switch_failed"),
    ] {
        assert_eq!(
            switched_entry(&start, "org_team", 200, body, now()).unwrap_err(),
            code
        );
    }
}

#[test]
fn errors_map_to_stable_codes() {
    let start = entry();
    let not_found = br#"{"errorCode":"organization_not_found","message":"Not found"}"#;
    let cases: [(u16, &[u8], &str); 5] = [
        (404, not_found, "organization_not_found"),
        (404, b"", "unsupported"),
        (401, b"{}", "unauthorized"),
        (429, b"{}", "rate_limited"),
        (500, b"", "switch_failed"),
    ];
    for (status, body, code) in cases {
        assert_eq!(
            switched_entry(&start, "org_team", status, body, now()).unwrap_err(),
            code
        );
    }
}

/// Serves one canned response on loopback and returns the request text.
fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let count = socket.read(&mut chunk).unwrap();
            bytes.extend_from_slice(&chunk[..count]);
            let text = String::from_utf8_lossy(&bytes).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length || count == 0 {
                    break;
                }
            }
        }
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .as_bytes(),
            )
            .unwrap();
        String::from_utf8_lossy(&bytes).to_string()
    });
    (base, server)
}

#[test]
fn the_switch_command_keeps_the_old_token_when_another_account_answers() {
    with_isolated_store(|| {
        let (base, server) = serve_once(
            r#"{"access_token":"kordi_cs_x","token_type":"Bearer","expires_in":3600,"account_id":"acct_b","device_id":"dev_a","organization_id":"org_team"}"#,
        );
        let start = CloudSessionEntry {
            token_endpoint: Some(format!("{base}{TOKEN_ENDPOINT_PATH}")),
            ..entry()
        };
        store_session_entry(&start).unwrap();
        let result = tauri::async_runtime::block_on(cloud_session_switch_organization(
            "kordi_cs_old".into(),
            "org_team".into(),
        ));
        assert_eq!(result.unwrap_err(), "account_mismatch");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/cloud/auth/organization-token "));
        assert!(request.contains("Bearer kordi_cs_old"));
        assert!(request.contains(r#""organization_id":"org_team""#));
        let loaded = cloud_session_load().unwrap().unwrap();
        assert_eq!(loaded.token, "kordi_cs_old");
        assert_eq!(loaded.organization_id, None);
    });
}

#[test]
fn the_switch_command_saves_through_the_issuing_server() {
    with_isolated_store(|| {
        let (base, server) = serve_once(
            r#"{"access_token":"kordi_cs_team","token_type":"Bearer","expires_in":3600,"account_id":"acct_a","device_id":"dev_a","sign_in_id":"signin_a","organization_id":"org_team"}"#,
        );
        let start = CloudSessionEntry {
            token_endpoint: Some(format!("{base}{TOKEN_ENDPOINT_PATH}")),
            ..entry()
        };
        store_session_entry(&start).unwrap();
        let stored = tauri::async_runtime::block_on(cloud_session_switch_organization(
            "kordi_cs_old".into(),
            "org_team".into(),
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(stored.token, "kordi_cs_team");
        assert_eq!(stored.refresh_token.as_deref(), Some("kordi_rt_a"));
        // A caller still holding the old token gets the switched session.
        let again = tauri::async_runtime::block_on(cloud_session_switch_organization(
            "kordi_cs_old".into(),
            "org_team".into(),
        ))
        .unwrap();
        assert_eq!(again.token, "kordi_cs_team");
        let elsewhere = tauri::async_runtime::block_on(cloud_session_switch_organization(
            "kordi_cs_old".into(),
            "org_other".into(),
        ));
        assert_eq!(elsewhere.unwrap_err(), "session_changed");
    });
}

#[test]
fn native_requests_name_the_organization_of_their_token() {
    remember_token_organization(&CloudSessionEntry {
        token: "kordi_cs_header".into(),
        organization_id: Some("org_header".into()),
        ..entry()
    });
    let tagged = reqwest::Client::new()
        .get("https://app.example.test/v2/chat/sync/bootstrap")
        .cloud_bearer_auth("kordi_cs_header")
        .build()
        .unwrap();
    assert_eq!(
        tagged.headers().get(ORGANIZATION_HEADER).unwrap(),
        "org_header"
    );
    assert_eq!(
        tagged.headers().get("authorization").unwrap(),
        "Bearer kordi_cs_header"
    );
    let untagged = reqwest::Client::new()
        .get("https://app.example.test/v2/chat/sync/bootstrap")
        .cloud_bearer_auth("kordi_cs_unknown")
        .build()
        .unwrap();
    assert!(untagged.headers().get(ORGANIZATION_HEADER).is_none());
}

#[test]
fn the_stored_session_keeps_its_field_names() {
    let value = serde_json::to_value(CloudSessionEntry {
        organization_id: Some("org_team".into()),
        ..entry()
    })
    .unwrap();
    for key in [
        "token",
        "accountId",
        "expiresAt",
        "deviceId",
        "refreshToken",
        "clientId",
        "tokenEndpoint",
        "organizationId",
    ] {
        assert!(value.get(key).is_some(), "{key}");
    }
    let older: CloudSessionEntry =
        serde_json::from_str(r#"{"token":"t","accountId":"acct_a","expiresAt":"x"}"#).unwrap();
    assert_eq!(older.organization_id, None);
    assert!(serde_json::to_value(older)
        .unwrap()
        .get("organizationId")
        .is_none());
}

#[test]
fn the_switch_endpoint_follows_the_issuing_server() {
    assert_eq!(
        organization_token_endpoint(&entry()).as_deref(),
        Some("https://app.example.test/v1/cloud/auth/organization-token")
    );
    let unsafe_endpoint = CloudSessionEntry {
        token_endpoint: Some("http://app.example.test/v1/cloud/auth/app/token".into()),
        ..entry()
    };
    assert!(organization_token_endpoint(&unsafe_endpoint).is_none());
}
