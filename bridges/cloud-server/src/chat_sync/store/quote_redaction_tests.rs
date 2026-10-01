use serde_json::json;

use super::*;

const SESSION: &str = "session:group:one";

fn action(kind: &str, session: &str, source_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": kind,
        "source": {
            "sourceSessionId": session,
            "sourceMessageId": source_id,
            "sourceMessageKind": "text",
            "senderLabel": "Alex",
            "textPreview": "the original wording",
            "attachmentCount": 2,
            "createdAtMs": 1,
            "timeLabel": "9:00",
            "mentions": [{"accountId": "acct", "label": "@Sam"}]
        }
    })
}

fn content(prefix: &str, envelope: &Value) -> Value {
    json!({
        "schema": 1,
        "blocks": [{
            "type": "text",
            "text": format!("{prefix}{}", URL_SAFE_NO_PAD.encode(envelope.to_string()))
        }]
    })
}

fn decoded(content: &Value) -> Value {
    let text = content["blocks"][0]["text"].as_str().unwrap();
    let prefix = [
        CLOUD_DIRECT_PREFIX,
        CLOUD_AGENT_RESPONSE_PREFIX,
        CLOUD_GROUP_PREFIX,
    ]
    .into_iter()
    .find(|prefix| text.starts_with(prefix))
    .unwrap();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&text[prefix.len()..]).unwrap()).unwrap()
}

fn sessions() -> Vec<String> {
    vec![SESSION.to_string(), "0190-conversation".to_string()]
}

fn ids() -> Vec<String> {
    vec!["source-id".to_string(), "logical-id".to_string()]
}

fn assert_scrubbed(source: &Value) {
    assert_eq!(source["textPreview"], "");
    assert_eq!(source["attachmentCount"], 0);
    assert_eq!(source["sourceDeleted"], true);
    assert!(source.get("mentions").is_none());
    assert_eq!(source["senderLabel"], "Alex");
    assert_eq!(source["timeLabel"], "9:00");
    assert_eq!(source["sourceMessageKind"], "text");
}

#[test]
fn direct_quotes_and_agent_response_threads_are_scrubbed() {
    for (prefix, kind) in [
        (CLOUD_DIRECT_PREFIX, "quote"),
        (CLOUD_DIRECT_PREFIX, "thread"),
        (CLOUD_AGENT_RESPONSE_PREFIX, "thread"),
    ] {
        let envelope = json!({
            "schemaVersion": 1,
            "kind": "message",
            "text": "my reply",
            "messageAction": action(kind, SESSION, "source-id")
        });
        let scrubbed = scrubbed_content(&content(prefix, &envelope), &sessions(), &ids())
            .unwrap_or_else(|| panic!("{prefix} {kind}"));
        let envelope = decoded(&scrubbed);
        assert_eq!(envelope["text"], "my reply");
        assert_eq!(envelope["messageAction"]["kind"], kind);
        assert_scrubbed(&envelope["messageAction"]["source"]);
        // A second pass leaves the reply alone.
        assert!(scrubbed_content(&scrubbed, &sessions(), &ids()).is_none());
    }
}

#[test]
fn group_threads_match_the_logical_id_and_collaboration_suffix() {
    for source_id in ["logical-id", " collaboration-message:logical-id "] {
        let envelope = json!({
            "kind": "group-message",
            "groupId": SESSION,
            "message": {
                "id": "reply",
                "text": "my reply",
                "messageAction": action("thread", SESSION, source_id)
            }
        });
        let scrubbed =
            scrubbed_content(&content(CLOUD_GROUP_PREFIX, &envelope), &sessions(), &ids())
                .expect("group thread is scrubbed");
        let envelope = decoded(&scrubbed);
        assert_eq!(envelope["message"]["id"], "reply");
        assert_eq!(envelope["groupId"], SESSION);
        assert_scrubbed(&envelope["message"]["messageAction"]["source"]);
    }
}

#[test]
fn forwards_other_sessions_and_other_sources_are_untouched() {
    let cases = [
        action("forward", SESSION, "source-id"),
        action("quote", "session:group:other", "source-id"),
        action("quote", SESSION, "another-message"),
        action("quote", SESSION, "collaboration-message:another-message"),
    ];
    for action in cases {
        let envelope =
            json!({"schemaVersion": 1, "kind": "message", "text": "x", "messageAction": action});
        assert!(scrubbed_content(
            &content(CLOUD_DIRECT_PREFIX, &envelope),
            &sessions(),
            &ids()
        )
        .is_none());
    }
    // The conversation id is accepted as the source session.
    let envelope = json!({"kind": "message", "messageAction": action("quote", "0190-conversation", "source-id")});
    assert!(scrubbed_content(
        &content(CLOUD_DIRECT_PREFIX, &envelope),
        &sessions(),
        &ids()
    )
    .is_some());
}

#[test]
fn plain_and_malformed_content_is_untouched() {
    let plain = json!({"schema": 1, "blocks": [{"type": "text", "text": "quote source-id"}]});
    assert!(scrubbed_content(&plain, &sessions(), &ids()).is_none());
    let malformed =
        json!({"schema": 1, "blocks": [{"type": "text", "text": "kordi-cloud-message:%%%"}]});
    assert!(scrubbed_content(&malformed, &sessions(), &ids()).is_none());
    // A group envelope keeps its action under `message`, not at the top level.
    let misplaced =
        json!({"kind": "group-message", "messageAction": action("quote", SESSION, "source-id")});
    assert!(scrubbed_content(
        &content(CLOUD_GROUP_PREFIX, &misplaced),
        &sessions(),
        &ids()
    )
    .is_none());
    assert!(scrubbed_content(&json!({}), &sessions(), &ids()).is_none());
}

#[test]
fn the_rewrite_keeps_the_envelope_in_place() {
    let envelope =
        json!({"kind": "message", "messageAction": action("quote", SESSION, "source-id")});
    let before = content(CLOUD_DIRECT_PREFIX, &envelope);
    let after = scrubbed_content(&before, &sessions(), &ids()).unwrap();
    assert!(ensure_rewrite_keeps_envelope_placement(&before, &after).is_ok());
    assert_eq!(after["schema"], 1);
    assert_eq!(after["blocks"].as_array().unwrap().len(), 1);
}
