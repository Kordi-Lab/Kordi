use super::*;

fn ids(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(ToString::to_string).collect()
}

#[test]
fn citing_items_are_removed_and_unrelated_items_kept() {
    let mut snapshot = json!({
        "claims": [
            {"id": "a", "title": "Removed", "sourceIds": ["gone"]},
            {"id": "b", "title": "Kept", "sourceIds": ["kept"]}
        ],
        "commitments": [{"id": "c", "title": "Also removed", "sourceIds": ["kept", "gone"]}],
        "suggestions": [{"id": "d", "title": "Kept", "sourceIds": []}],
        "calendarCandidates": [{"id": "e", "title": "Removed", "sourceIds": ["gone"]}],
        "removedItemIds": ["older"],
        "futureField": {"kept": true}
    });
    assert!(remove_citing_items(&mut snapshot, &ids(&["gone"])));
    assert_eq!(
        snapshot["claims"],
        json!([{"id": "b", "title": "Kept", "sourceIds": ["kept"]}])
    );
    assert_eq!(snapshot["commitments"], json!([]));
    assert_eq!(snapshot["suggestions"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["calendarCandidates"], json!([]));
    assert_eq!(snapshot["removedItemIds"], json!(["older"]));
    assert_eq!(snapshot["futureField"], json!({"kept": true}));
    // A second pass finds nothing left to remove.
    assert!(!remove_citing_items(&mut snapshot, &ids(&["gone"])));
}

#[test]
fn saved_evidence_drops_the_source_and_run_only_context() {
    let mut input = json!({
        "sources": [
            {"id": "gone", "text": "removed text", "version": 1},
            {"id": "kept", "text": "kept text", "version": 2, "replyToSourceId": "gone"}
        ],
        "calendarEvents": [
            {"id": "event-1", "title": "From the removed message", "sourceIds": ["gone"]},
            {"id": "event-2", "title": "Unrelated", "sourceIds": ["kept"]}
        ],
        "existingTasks": [],
        "previous": {"claims": [{"id": "a", "title": "Removed", "sourceIds": ["gone"]}]},
        "changes": {"sources": [{"id": "gone", "text": "removed text"}]},
        "locale": "en",
        "futureField": 1
    });
    assert!(scrub_saved_input(&mut input, &ids(&["gone"])));
    let sources = input["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["id"], "kept");
    assert_eq!(input["calendarEvents"].as_array().unwrap().len(), 1);
    assert_eq!(input["previous"], Value::Null);
    assert_eq!(input["changes"], Value::Null);
    assert_eq!(input["locale"], "en");
    assert_eq!(input["futureField"], 1);
    assert!(!input.to_string().contains("removed text"));
    // The scrubbed evidence still reads as a digest input.
    let mut typed = input.clone();
    typed["calendarEvents"] = json!([]);
    for field in ["timezone", "asOf", "viewerAccountId"] {
        typed[field] = json!("value");
    }
    typed["partial"] = json!(false);
    typed["sources"][0] = serde_json::to_value(super::super::models::Source {
        id: "kept".into(),
        conversation_id: "c".into(),
        session_id: "s".into(),
        session_title: "t".into(),
        sender_account_id: "a".into(),
        sender_name: "n".into(),
        sender_avatar_url: None,
        text: "kept text".into(),
        created_at: "2026-09-07T09:00:00Z".into(),
        version: 2,
        is_agent: false,
        agent_id: None,
        agent_owner_name: None,
        agent_avatar_url: None,
        reply_to_source_id: None,
    })
    .unwrap();
    let parsed: super::super::models::Input = serde_json::from_value(typed).unwrap();
    assert!(parsed.previous.is_none() && parsed.changes.is_none());
}

#[test]
fn saved_evidence_without_the_source_is_unchanged_apart_from_run_context() {
    let mut input = json!({
        "sources": [{"id": "kept", "text": "kept text", "version": 1}],
        "previous": {"claims": [{"id": "b", "sourceIds": ["kept"]}]}
    });
    assert!(!scrub_saved_input(&mut input, &ids(&["gone"])));
    assert_eq!(input["sources"].as_array().unwrap().len(), 1);
    assert_eq!(input["previous"], Value::Null);
}

#[test]
fn mentions_match_whole_strings_only() {
    let value = json!({"sources": [{"id": "abc", "text": "mentions abcd and gone-ish"}]});
    assert!(mentions_any(&value, &ids(&["abc"])));
    assert!(!mentions_any(&value, &ids(&["gone"])));
    assert!(!mentions_any(&json!({}), &ids(&["abc"])));
}

#[test]
fn like_patterns_match_the_json_string_literally() {
    assert_eq!(like_pattern("0190-ab"), "%\"0190-ab\"%");
    assert_eq!(like_pattern("a_b%c"), "%\"a\\_b\\%c\"%");
    assert_eq!(like_pattern("quote\"d"), "%\"quote\\\\\"d\"%");
}

#[test]
fn cited_sources_keep_the_recorded_version() {
    let snapshot = json!({"claims": [{"sourceIds": ["one", "two"]}]});
    let saved = json!({"sources": [{"id": "two", "version": 3}]});
    let cited = cited_sources(Some(&snapshot), Some(&saved));
    assert_eq!(cited.get("one"), Some(&None));
    assert_eq!(cited.get("two"), Some(&Some(3)));
    assert!(cited_sources(None, None).is_empty());
}
