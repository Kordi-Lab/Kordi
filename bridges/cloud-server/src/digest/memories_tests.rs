use super::*;
use crate::digest::models::{Input, Output};

const OWNER: &str = "owner";

fn source(id: &str, session: &str, sender: &str) -> Source {
    Source {
        id: id.into(),
        conversation_id: "c1".into(),
        session_id: session.into(),
        session_title: "Planning".into(),
        sender_account_id: sender.into(),
        sender_name: "Sender".into(),
        sender_avatar_url: None,
        text: "From now on keep replies short.".into(),
        created_at: "2026-10-24T09:00:00Z".into(),
        version: 1,
        is_agent: false,
        agent_id: None,
        agent_owner_name: None,
        agent_avatar_url: None,
        reply_to_source_id: None,
    }
}

fn memory(scope: &str, session: Option<&str>, ids: &[&str]) -> DigestMemory {
    DigestMemory {
        text: "Prefers short replies".into(),
        category: "general_preferences".into(),
        confidence: "high".into(),
        scope: scope.into(),
        session_id: session.map(Into::into),
        source_message_ids: ids.iter().map(|id| id.to_string()).collect(),
    }
}

#[test]
fn replies_parse_with_and_without_memories() {
    let plain: Output = serde_json::from_str(
        r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[]}"#,
    )
    .unwrap();
    assert!(plain.memories.is_empty());
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("memories")
        .is_none());
    let with: Output = serde_json::from_str(
        r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[],
        "memories":[{"text":"Prefers short replies","category":"general_preferences",
        "confidence":"high","scope":"global","sourceMessageIds":["m1"]},
        {"text":42},"not a memory"]}"#,
    )
    .unwrap();
    assert_eq!(with.memories, vec![memory("global", None, &["m1"])]);
    let odd: Output = serde_json::from_str(
        r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[],"memories":"none"}"#,
    )
    .unwrap();
    assert!(odd.memories.is_empty());
}

#[test]
fn the_reply_clean_up_keeps_memories_in_the_schema() {
    let reply = r#"{"claims":[],"memories":[{"text":"T","scope":"global","extra":1},3],"note":1}"#;
    let input = json!({"sources": []});
    let output: Value =
        serde_json::from_str(&super::super::output::normalized_reply(reply, &input)).unwrap();
    assert_eq!(output["memories"], json!([{"text":"T","scope":"global"}]));
    assert!(output.get("note").is_none());
}

#[test]
fn incremental_prompts_carry_the_existing_memories() {
    let mut input = super::super::tests::input();
    input.previous = Some(Output::default());
    input.changes = Some(Default::default());
    input.memories = vec![ExistingMemory {
        text: "Prefers short replies".into(),
        scope: "global".into(),
        scope_id: "account".into(),
        category: "general_preferences".into(),
    }];
    let prompt = super::super::output::prompt(&serde_json::to_value(&input).unwrap()).unwrap();
    assert!(
        prompt.contains(r#""memories":[{"text":"Prefers short replies""#),
        "{prompt}"
    );
    let back: Input = serde_json::from_value(serde_json::to_value(&input).unwrap()).unwrap();
    assert_eq!(back.memories, input.memories);
}

#[test]
fn targets_follow_the_scope_and_source_rules() {
    let group = uuid::Uuid::new_v4();
    let mut sources = vec![
        source("own", "s1", OWNER),
        source("other", "s1", "someone"),
        source("agent", "s1", OWNER),
        source("in-group", &format!("session:group:{group}"), "someone"),
    ];
    sources[2].is_agent = true;
    sources[3].conversation_id = group.to_string();

    let global = target(&memory("global", None, &["own"]), OWNER, &sources).unwrap();
    assert_eq!(
        (global.scope, global.scope_id.as_str()),
        ("global", "account")
    );
    assert!(global.scope_label.is_none());
    let chat = target(
        &memory("conversation", Some("s1"), &["own"]),
        OWNER,
        &sources,
    )
    .unwrap();
    assert_eq!((chat.scope, chat.scope_id.as_str()), ("conversation", "s1"));
    assert_eq!(chat.scope_label.as_deref(), Some("Planning"));

    let refused = |memory: DigestMemory| target(&memory, OWNER, &sources).unwrap_err();
    assert_eq!(
        refused(memory("global", None, &["other"])),
        "not_owner_message"
    );
    assert_eq!(
        refused(memory("global", None, &["agent"])),
        "not_owner_message"
    );
    assert_eq!(
        refused(memory("conversation", Some("s1"), &["other"])),
        "not_owner_message"
    );
    assert_eq!(
        refused(memory("conversation", None, &["own"])),
        "missing_session"
    );
    assert_eq!(
        refused(memory("conversation", Some("s2"), &["own"])),
        "source_outside_session"
    );
    assert_eq!(
        refused(memory("global", None, &["missing"])),
        "unknown_source"
    );
    assert_eq!(refused(memory("global", None, &[])), "invalid_sources");
    assert_eq!(
        refused(memory("project", Some("s1"), &["own"])),
        "invalid_scope"
    );
    let mut long = memory("global", None, &["own"]);
    long.text = "x".repeat(501);
    assert_eq!(refused(long), "invalid_text");
    let mut unknown = memory("global", None, &["own"]);
    unknown.category = "diary".into();
    assert_eq!(refused(unknown), "invalid_category");
    let mut health = memory("global", None, &["own"]);
    health.category = "health_context".into();
    assert_eq!(refused(health), "category_not_allowed");
    let mut sure = memory("global", None, &["own"]);
    sure.confidence = "certain".into();
    assert_eq!(refused(sure), "invalid_confidence");

    // A group memory may rest on another member's message, in that group only.
    let session = format!("session:group:{group}");
    let shared = target(
        &memory("group", Some(&session), &["in-group"]),
        OWNER,
        &sources,
    )
    .unwrap();
    assert_eq!(
        (shared.scope, shared.scope_id),
        ("group", group.to_string())
    );
    let mut personal = memory("group", Some(&session), &["in-group"]);
    personal.category = "location_context".into();
    assert_eq!(refused(personal), "category_not_shared");
    assert_eq!(
        refused(memory("group", Some("s1"), &["own"])),
        "not_a_group_session"
    );
}

#[path = "memories_pg_tests.rs"]
mod postgres;
