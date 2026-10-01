use super::history::RAW_OMP_MESSAGE;
use super::history::resolve_omp_transport;
use super::history::route_scope_for;
use super::host::preserve_raw_context_messages;
use super::*;
use kordi_core::types::UserMessage;

#[test]
fn only_explicit_omp_selection_changes_the_default_engine() {
    assert_eq!(DesktopTurnEngine::from_setting(""), DesktopTurnEngine::Rust);
    assert_eq!(
        DesktopTurnEngine::from_setting("unknown"),
        DesktopTurnEngine::Rust
    );
    assert_eq!(
        DesktopTurnEngine::from_setting(" OMP "),
        DesktopTurnEngine::Omp
    );
}

#[test]
fn chatgpt_oauth_uses_selected_codex_transport_and_account() -> Result<()> {
    let mut headers = std::collections::HashMap::new();
    headers.insert("ChatGPT-Account-ID".into(), "stale-account".into());
    let (provider, api, base_url, headers) = resolve_omp_transport(
        "openai",
        Some("openai-responses".into()),
        "https://api.openai.com/v1",
        &headers,
        Some(ProviderAuthMethod::OAuth),
        Some("openai-codex"),
        Some("selected-account"),
    )?;
    assert_eq!(provider, "openai-codex");
    assert_eq!(api.as_deref(), Some("openai-codex-responses"));
    assert_eq!(base_url.as_deref(), Some("https://chatgpt.com/backend-api"));
    assert_eq!(
        headers.get("chatgpt-account-id").map(String::as_str),
        Some("selected-account")
    );
    assert_eq!(headers.len(), 1);
    assert!(
        resolve_omp_transport(
            "openai",
            None,
            "",
            &std::collections::HashMap::new(),
            Some(ProviderAuthMethod::OAuth),
            Some("openai-codex"),
            None,
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn api_key_and_other_oauth_routes_keep_their_explicit_transport() -> Result<()> {
    let headers = std::collections::HashMap::new();
    for (provider, auth_method) in [
        ("openai", ProviderAuthMethod::ApiKey),
        ("anthropic", ProviderAuthMethod::OAuth),
    ] {
        let route = resolve_omp_transport(
            provider,
            Some("openai-responses".into()),
            "https://synthetic.invalid/v1",
            &headers,
            Some(auth_method),
            Some(provider),
            Some("account"),
        )?;
        assert_eq!(route.0, provider);
        assert_eq!(route.1.as_deref(), Some("openai-responses"));
        assert_eq!(route.2.as_deref(), Some("https://synthetic.invalid/v1"));
        assert!(!route.3.contains_key("chatgpt-account-id"));
    }
    Ok(())
}

#[test]
fn raw_replay_scope_tracks_exact_route_and_account_but_survives_refresh() -> Result<()> {
    let api = serde_json::json!("openai-responses");
    let original = route_scope_for(
        "provider",
        "model",
        api.clone(),
        "https://synthetic.invalid",
        Some("account-a"),
        "token-one",
    )?;
    let refreshed = route_scope_for(
        "provider",
        "model",
        api.clone(),
        "https://synthetic.invalid",
        Some("account-a"),
        "token-two",
    )?;
    let other_account = route_scope_for(
        "provider",
        "model",
        api.clone(),
        "https://synthetic.invalid",
        Some("account-b"),
        "token-one",
    )?;
    let other_model = route_scope_for(
        "provider",
        "model-2",
        api.clone(),
        "https://synthetic.invalid",
        Some("account-a"),
        "token-one",
    )?;
    let anonymous_one = route_scope_for(
        "provider",
        "model",
        api.clone(),
        "https://synthetic.invalid",
        None,
        "token-one",
    )?;
    let anonymous_two = route_scope_for(
        "provider",
        "model",
        api,
        "https://synthetic.invalid",
        None,
        "token-two",
    )?;
    assert_eq!(original, refreshed);
    assert_ne!(original, other_account);
    assert_ne!(original, other_model);
    assert_ne!(anonymous_one, anonymous_two);
    Ok(())
}

#[test]
fn context_filter_preserves_opaque_signature_after_reordering() -> Result<()> {
    let first =
        serde_json::json!({"role":"user","content":[{"type":"text","text":"old"}],"timestamp":1});
    let signed = serde_json::json!({"role":"assistant","provider":"synthetic","model":"model","content":[{"type":"text","text":"answer","textSignature":"opaque"}],"usage":{"input":0,"output":0,"cache_read":0,"cache_write":0,"total_tokens":0,"cost":{"input":0,"output":0,"cache_read":0,"cache_write":0,"total":0}},"stop_reason":"stop","timestamp":2});
    let raw = vec![first.clone(), signed.clone()];
    let typed = raw
        .iter()
        .cloned()
        .map(serde_json::from_value::<AgentMessage>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let replacement = vec![serde_json::to_value(&typed[1])?];
    let preserved = preserve_raw_context_messages(&raw, &typed, replacement);
    assert_eq!(preserved, vec![signed]);
    Ok(())
}

#[test]
fn active_history_replays_raw_omp_fields_without_repeating_current_request() -> Result<()> {
    let conn = store::open_memory()?;
    let session_id = store::create_session(&conn, "/tmp")?;
    let first_id = EntryId::generate();
    let first = SessionEntry::Message {
        base: EntryBase {
            id: first_id.clone(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "first".into(),
            }],
            timestamp: 100,
        }),
    };
    store::append_entry(&conn, &session_id, &first)?;
    let raw = serde_json::json!({
        "role": "assistant", "provider": "synthetic", "model": "synthetic-model",
        "api": "openai-responses", "content": [{"type":"thinking", "thinking":"reason", "thinkingSignature":"signature"}, {"type":"text", "text":"reply"}],
        "usage": {"input": 1, "output": 1, "cache_read": 0, "cache_write": 0, "total_tokens": 2, "cost": {"input":0,"output":0,"cache_read":0,"cache_write":0,"total":0}},
        "stop_reason": "stop", "timestamp": 101,
    });
    let assistant_id = EntryId::generate();
    store::append_entry(
        &conn,
        &session_id,
        &SessionEntry::Message {
            base: EntryBase {
                id: assistant_id.clone(),
                parent_id: Some(first_id),
                timestamp: Utc::now(),
            },
            message: serde_json::from_value(raw.clone())?,
        },
    )?;
    store::append_entry(
        &conn,
        &session_id,
        &SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: Some(assistant_id.clone()),
                timestamp: Utc::now(),
            },
            custom_type: RAW_OMP_MESSAGE.into(),
            data: Some(
                serde_json::json!({ "entryId": assistant_id.as_str(), "routeScope": "route-a", "message": raw }),
            ),
        },
    )?;
    let current_id = EntryId::generate();
    store::append_entry(
        &conn,
        &session_id,
        &SessionEntry::Message {
            base: EntryBase {
                id: current_id.clone(),
                parent_id: get_leaf_raw(&conn, &session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "next".into(),
                }],
                timestamp: 102,
            }),
        },
    )?;
    store::append_entry(
        &conn,
        &session_id,
        &SessionEntry::CustomMessage {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: get_leaf_raw(&conn, &session_id),
                timestamp: Utc::now(),
            },
            custom_type: "turn_context".into(),
            content: vec![ContentBlock::Text {
                text: "follow current request".into(),
            }],
            display: false,
            details: None,
        },
    )?;
    let (messages, ids, prompt_id, images, trailing) =
        prepare_history(&conn, &session_id, "route-a")?;
    assert_eq!(prompt_id, current_id.as_str());
    assert!(images.is_empty());
    assert_eq!(trailing.len(), 1);
    assert_eq!(trailing[0]["role"], "custom");
    assert_eq!(trailing[0]["content"][0]["text"], "follow current request");
    assert_eq!(
        ids,
        vec![
            Some(first.base().id.as_str().into()),
            Some(assistant_id.as_str().into())
        ]
    );
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["content"][0]["thinkingSignature"], "signature");
    let (other_route, _, _, _, _) = prepare_history(&conn, &session_id, "route-b")?;
    assert!(
        other_route[1]["content"][0]
            .get("thinkingSignature")
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn malformed_omp_result_does_not_append_partial_history() -> Result<()> {
    let conn = store::open_memory()?;
    let session_id = store::create_session(&conn, "/tmp")?;
    let prompt_id = EntryId::generate();
    store::append_entry(
        &conn,
        &session_id,
        &SessionEntry::Message {
            base: EntryBase {
                id: prompt_id.clone(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "hello".into(),
                }],
                timestamp: 1,
            }),
        },
    )?;
    let conn = std::sync::Arc::new(tokio::sync::Mutex::new(conn));
    let request: RunRequest = serde_json::from_value(serde_json::json!({
        "runId":"run", "requestId":prompt_id.as_str(), "attemptId":"attempt", "sessionId":session_id,
        "model":{"provider":"synthetic","id":"model"}, "auth":{"kind":"api_key","credential":"synthetic"},
        "systemPrompt":"test", "messages":[], "prompt":{"text":"hello","entryId":prompt_id.as_str()},
        "cwd":"/tmp", "tools":[], "limits":{"timeoutMs":1000,"maxOutputBytes":100000,"maxToolCalls":1,"maxSteps":1}
    }))?;
    let valid = serde_json::json!({
        "role":"assistant", "provider":"synthetic", "model":"model", "content":[{"type":"text","text":"partial"}],
        "usage":{"input":1,"output":1,"cache_read":0,"cache_write":0,"total_tokens":2,"cost":{"input":0,"output":0,"cache_read":0,"cache_write":0,"total":0}},
        "stop_reason":"stop", "timestamp":2
    });
    let result = kordi_omp_runtime::RunResult {
        text: "partial".into(),
        messages: vec![valid, serde_json::json!({"role":"assistant"})],
        context_messages: vec![],
        usage: None,
        stop_reason: None,
        checkpoint: None,
    };
    assert!(
        persist_result(&conn, &request.session_id, "route-a", &request, &result)
            .await
            .is_err()
    );
    let conn = conn.lock().await;
    assert_eq!(store::get_entries(&conn, &request.session_id)?.len(), 1);
    Ok(())
}
