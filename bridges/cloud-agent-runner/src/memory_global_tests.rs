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

async fn scripted_save(run: &CloudAgentRun, scope: &str, scope_id: &str) -> (MemoryClient, Value) {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": scope,
                "scopeId": scope_id,
                "source": "user_correction",
                "lesson": "Always answer in British English.",
            }),
        },
    ])]);
    run_model_loop(&client, &provider, run, &sandbox(), auth_material())
        .await
        .expect("memory problems never fail the run");
    let message = tool_message(&provider);
    (client, message)
}

#[tokio::test]
async fn saves_outside_the_runs_scopes_are_refused_before_saving() {
    let mut other_request = run();
    other_request.requester_account_id = "acct_member".into();
    for (run, scope, scope_id) in [
        (other_request.clone(), "global", "account"),
        (run(), "conversation", "session:group:grp_other"),
        (run(), "group", "grp_other"),
        (run(), "project", "proj_1"),
    ] {
        let (client, message) = scripted_save(&run, scope, scope_id).await;
        assert!(client.saved.lock().unwrap().is_empty(), "{scope}");
        let message = message.as_str().unwrap();
        assert!(
            message.starts_with("Memories from this run can only be saved in these scopes:"),
            "{message}"
        );
        assert!(message.contains("conversation `session:group:grp_alpha`"));
        assert!(message.contains("group `grp_alpha`"));
        assert_eq!(
            message.contains("global `account`"),
            run.requester_account_id == run.owner_account_id
        );
    }

    // A member's request still saves into the run's group.
    let (client, _) = scripted_save(&other_request, "group", "grp_alpha").await;
    assert_eq!(client.saved.lock().unwrap().len(), 1);
    // And the prompt offers no global scope to a member's request.
    let section = memory_prompt_section(
        &other_request,
        &RunMemory {
            enabled: true,
            exclude_sensitive: true,
            memories: Vec::new(),
        },
    )
    .unwrap();
    assert!(section.contains(
        "Scope ids for this run: conversation `session:group:grp_alpha`, group `grp_alpha`."
    ));
}
