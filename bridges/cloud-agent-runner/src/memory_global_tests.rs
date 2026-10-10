//! Global memories and "already saved" results in cloud runs (#1710).

use super::*;

fn reflection_call(lesson: &str) -> ScriptedProvider {
    ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "global",
                "scopeId": "account",
                "source": "user_correction",
                "lesson": lesson,
            }),
        },
    ])])
}

fn tool_message(provider: &ScriptedProvider) -> Value {
    provider
        .last_messages()
        .into_iter()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .clone()
}

#[test]
fn prompt_lists_global_memories_first_then_conversation_and_group() {
    let memory = RunMemory {
        enabled: true,
        exclude_sensitive: true,
        memories: vec![
            memory_row(
                "mem_c",
                "conversation",
                SESSION_ID,
                "Use metric units here.",
                "2026-10-03T00:00:00+00:00",
            ),
            memory_row(
                "mem_g",
                "group",
                "grp_alpha",
                "Reports go out on Fridays.",
                "2026-10-04T00:00:00+00:00",
            ),
            memory_row(
                "mem_a",
                "global",
                "account",
                "Always answer in British English.",
                "2026-10-01T00:00:00+00:00",
            ),
            memory_row(
                "mem_x",
                "global",
                "acct_other",
                "Not an account-wide memory.",
                "2026-10-05T00:00:00+00:00",
            ),
        ],
    };
    let section = memory_prompt_section(&run(), &memory).unwrap();
    let global = section
        .find("\nGlobal:\n- Always answer in British English.")
        .expect("global block");
    let conversation = section
        .find("\nThis conversation:\n- Use metric units here.")
        .expect("conversation block");
    let group = section
        .find("\nThis group:\n- Reports go out on Fridays.")
        .expect("group block");
    assert!(global < conversation && conversation < group);
    assert!(!section.contains("Not an account-wide memory."));
    assert!(section.contains("skip anything already there or restated"));
    assert!(section.contains("Use `global` only for preferences the user wants everywhere"));
    assert!(section.contains("global `account`"));
}

#[tokio::test]
async fn new_global_memory_is_reported_as_saved() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = reflection_call("Always answer in British English.");
    run_with(&client, &provider).await;

    let saved = client.saved.lock().unwrap().clone();
    assert_eq!(saved[0].1.scope, "global");
    assert_eq!(saved[0].1.scope_id, "account");
    assert_eq!(
        tool_message(&provider),
        "Reflection lesson saved to kordi-memory://global/account"
    );
}

#[tokio::test]
async fn existing_memory_is_reported_as_already_saved() {
    let mut client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    client.existing_id = Some("mem_existing".into());
    let provider = reflection_call("  Always answer in   British English. ");
    run_with(&client, &provider).await;

    assert_eq!(
        tool_message(&provider),
        "Memory already saved: Always answer in British English."
    );
}

#[tokio::test]
async fn global_memory_with_another_scope_id_is_refused_before_saving() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "global",
                "scopeId": SESSION_ID,
                "source": "user_correction",
                "lesson": "Always answer in British English.",
            }),
        },
    ])]);
    run_with(&client, &provider).await;

    assert!(client.saved.lock().unwrap().is_empty());
    let message = tool_message(&provider);
    assert!(
        message.as_str().unwrap().contains("must be `account`"),
        "{message}"
    );
}
