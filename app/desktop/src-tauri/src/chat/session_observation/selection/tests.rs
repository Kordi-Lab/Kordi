use crate::chat::session_observation::selection::*;
use crate::chat::session_preparation::group_tools_tests::{
    group_lease, identity, EnvGuard, GROUP, OWNER,
};
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PERSONAL: &str = "session:self-agent:synthetic-owner";

fn private_lease() -> DesktopCloudExecutionLease {
    let mut lease = group_lease();
    lease.session_id = PERSONAL.into();
    lease.connector_audience = Some("owner_private".into());
    lease
}

#[test]
fn only_owner_private_personal_leases_allow_catalog_discovery() {
    let lease = private_lease();
    let owner = identity(OWNER, Some(lease.clone()));
    assert!(owner_personal_turn(Some(&lease), None, Some(&owner)));
    assert!(owner_personal_turn(
        Some(&lease),
        Some(PERSONAL),
        Some(&owner)
    ));
    assert!(!owner_personal_turn(
        Some(&lease),
        Some(GROUP),
        Some(&owner)
    ));
    assert!(!owner_personal_turn(Some(&lease), None, None));
    assert!(!owner_personal_turn(None, None, Some(&owner)));
    assert!(!owner_personal_turn(
        Some(&lease),
        None,
        Some(&identity("other", Some(lease.clone())))
    ));
    let mut malformed = owner.clone();
    malformed.text = "invalid".into();
    assert!(!owner_personal_turn(Some(&lease), None, Some(&malformed)));
    for audience in [None, Some("shared".into()), Some("unknown".into())] {
        let mut shared = lease.clone();
        shared.connector_audience = audience;
        assert!(!owner_personal_turn(Some(&shared), None, Some(&owner)));
    }
    let mut mismatched = lease.clone();
    mismatched.owner_account_id = "other".into();
    assert!(!owner_personal_turn(Some(&mismatched), None, Some(&owner)));
    let mut group = lease.clone();
    group.session_id = GROUP.into();
    assert!(!owner_personal_turn(Some(&group), None, Some(&owner)));
}

#[tokio::test]
async fn group_and_foreign_leases_still_reject_cross_conversation_reads() {
    for lease in [group_lease(), private_lease()] {
        let context = identity("other", Some(lease.clone()));
        let runtime = build(Some(lease), None, None, None, Some(context));
        let request =
            serde_json::from_value(json!({"sessionId":"another-conversation","mode":"index"}))
                .unwrap();
        let error = (runtime.read_session)(request).await.unwrap_err();
        assert!(error.to_string().contains("unavailable"));
    }
}

async fn exchange(listener: &tokio::net::TcpListener, body: Value) -> String {
    let (mut socket, _) =
        tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let n = socket.read(&mut chunk).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let length = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn personal_leased_preparation_and_search_use_the_owner_catalog() {
    let storage = crate::test_support::ScopedKordiStorageRoot::new("personal-lease-discovery");
    let app = storage.root().join("app");
    let cwd = storage.root().join("workspace");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let _env = EnvGuard::set(&[
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", base.into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);
    crate::cloud_session::store_session_for_test(OWNER).unwrap();
    let server = tokio::spawn(async move {
        let catalog = json!({"conversations":[
            {"id":"personal","legacy_session_id":PERSONAL,"kind":"ai","shared_title":"Personal Agent",
             "members":[{"account_id":OWNER,"membership_state":"active"}]},
            {"id":"group","legacy_session_id":GROUP,"kind":"group","group_title":"Synthetic Grounding Group","shared_title":"Channel 1",
             "members":[{"account_id":OWNER,"membership_state":"active"}]}
        ]});
        let capabilities = exchange(&listener, json!({"available":false})).await;
        assert!(capabilities
            .starts_with("POST /v1/cloud/agent-runs/desktop/car_synthetic/agent-exchange "));
        // Preparation itself preloads current attachment references. The
        // old unconditional lease branch POSTed to a single-session endpoint.
        let first = exchange(&listener, catalog.clone()).await;
        assert!(
            first.starts_with("GET /v2/chat/sync/bootstrap "),
            "expected catalog discovery, got {}",
            first.lines().next().unwrap_or_default()
        );
        let second = exchange(&listener,json!({"session":{"sessionId":PERSONAL,"title":"Personal Agent","kind":"ai","participants":[]},
            "window":{"hasMoreBefore":false,"hasMoreAfter":false},"messages":[]})).await;
        assert!(second.starts_with("POST /v1/cloud/agent-runs/desktop/read-context "));
        let third = exchange(&listener, catalog).await;
        assert!(third.starts_with("GET /v2/chat/sync/bootstrap "));
    });
    let lease = private_lease();
    let context = vec![identity(OWNER, Some(lease.clone()))];
    let mut runtime = kordi_cli::desktop_runtime::DesktopRuntimeSession::create_with_id(
        cwd.clone(),
        "personal-lease-test",
    )
    .await
    .unwrap();
    runtime.sync_context_messages(&context).unwrap();
    crate::chat::session_preparation::prepare_desktop_session_for_send(
        &crate::chat::DesktopChatManager::default(),
        &mut runtime,
        cwd,
        "Read the latest Grounding images.",
        (None, None),
        Some("synthetic-request"),
        &context,
        (None, None),
    )
    .await
    .unwrap();
    assert!(!runtime
        .next_turn_system_prompt()
        .contains("Current shared session:"));
    let observer = build(Some(lease), None, None, None, Some(context[0].clone()));
    let result = (observer.search_sessions)(kordi_tools::SearchSessionsRequest {
        query: "Grounding".into(),
        limit: Some(20),
        include_messages: Some(false),
        before_sequence: Some(1),
    })
    .await
    .unwrap();
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].session_id, GROUP);
    server.await.unwrap();
}
