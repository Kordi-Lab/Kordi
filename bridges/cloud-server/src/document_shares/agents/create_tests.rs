use serde_json::json;
use uuid::Uuid;

use super::group_message::{document_envelope, DocumentMessage};
use super::record::derived_attachment_id;
use super::reply::{add_to_request, RunDocument};
use super::{file_name_for, parse, placeholder_title, schema, NewDocument};
use crate::chat_sync::models::SendMessageRequest;
use crate::document_shares::agents::tools::ToolError;

#[test]
fn titles_become_slugged_file_names() {
    assert_eq!(file_name_for("Launch plan", "md"), "launch-plan.md");
    assert_eq!(
        file_name_for("Q3: plan / budget?", "md"),
        "q3-plan-budget.md"
    );
    assert_eq!(file_name_for("notes.md", "md"), "notes.md");
    assert_eq!(file_name_for("Report.HTML", "html"), "report.html");
    assert_eq!(file_name_for("../../etc/passwd", "md"), "etc-passwd.md");
    assert_eq!(file_name_for("Café tips", "md"), "café-tips.md");
    assert_eq!(file_name_for("!!!", "md"), "document.md");
    let long = "x".repeat(300);
    assert_eq!(file_name_for(&long, "md").len(), 80 + 3);
}

#[test]
fn placeholder_titles_are_recognized() {
    for title in [
        "Untitled",
        "untitled.md",
        "Untitled 2",
        "New document",
        "Document",
        "doc",
    ] {
        assert!(placeholder_title(title), "{title}");
    }
    for title in [
        "Untitled ideas",
        "Launch plan",
        "Document review notes",
        "New hires",
    ] {
        assert!(!placeholder_title(title), "{title}");
    }
}

#[test]
fn arguments_are_checked_and_errors_ask_for_one_finished_call() {
    let document = parse(&json!({ "title": "  Launch   plan ", "content": "# Launch\n" })).unwrap();
    assert_eq!(
        document,
        NewDocument {
            title: "Launch plan".into(),
            file_name: "launch-plan.md".into(),
            content_type: "text/markdown",
            content: "# Launch\n".into(),
        }
    );
    let html =
        parse(&json!({ "title": "Page", "content": "<h1>x</h1>", "format": "html" })).unwrap();
    assert_eq!(
        (html.content_type, html.file_name.as_str()),
        ("text/html", "page.html")
    );

    let too_big = "a".repeat(super::MAX_TOOL_TEXT_BYTES + 1);
    for args in [
        // The reported document: a placeholder name and a single line break.
        json!({ "title": "Untitled", "content": "\n" }),
        json!({}),
        json!({ "content": "# Plan" }),
        json!({ "title": "", "content": "# Plan" }),
        json!({ "title": "Untitled.md", "content": "# Plan" }),
        json!({ "title": "t".repeat(201), "content": "x" }),
        json!({ "title": "Plan", "content": "  \n" }),
        json!({ "title": "Plan" }),
        json!({ "title": "Plan", "content": "x", "format": "docx" }),
        json!({ "title": "Plan", "content": too_big }),
    ] {
        match parse(&args) {
            Err(ToolError::Invalid(message)) => assert!(!message.is_empty(), "{args}"),
            other => panic!("{args}: {other:?}"),
        }
    }
    let Err(ToolError::Invalid(message)) = parse(&json!({ "title": "Untitled", "content": "\n" }))
    else {
        panic!("refused");
    };
    assert!(message.contains("placeholder") && message.contains("call create_document once"));
}

#[test]
fn the_schema_requires_a_title_and_finished_content() {
    let schema = schema();
    assert_eq!(schema["required"], json!(["title", "content"]));
    assert_eq!(schema["properties"]["title"]["minLength"], 1);
    assert_eq!(schema["properties"]["content"]["minLength"], 1);
    assert_eq!(schema["additionalProperties"], false);
}

#[test]
fn ids_are_stable_for_a_retry_and_differ_per_run_and_content() {
    let document = parse(&json!({ "title": "Plan", "content": "# Plan\n" })).unwrap();
    let first = derived_attachment_id("run_a", &document);
    assert_eq!(first, derived_attachment_id("run_a", &document));
    assert_ne!(first, derived_attachment_id("run_b", &document));
    let other = parse(&json!({ "title": "Plan", "content": "# Plan 2\n" })).unwrap();
    assert_ne!(first, derived_attachment_id("run_a", &other));
    assert!(first.starts_with("att_agentdoc_"));
}

fn document() -> RunDocument {
    RunDocument {
        attachment_id: "att_agentdoc_1".into(),
        file_name: "plan.md".into(),
        content_type: "text/markdown".into(),
        size_bytes: 7,
    }
}

#[test]
fn a_reply_carries_the_document_in_its_envelope_and_attachments() {
    let envelope = json!({ "kind": "group-message", "message": { "id": "r1", "senderKind": "agent",
        "text": "Done", "attachments": [] } });
    let body = format!(
        "kordi-cloud-group:{}",
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serde_json::to_vec(&envelope).unwrap()
        )
    );
    let mut request = SendMessageRequest {
        client_message_id: Uuid::nil(),
        kind: "text".into(),
        content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": body }] }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    add_to_request(&mut request, &[document()]);
    add_to_request(&mut request, &[document()]);
    assert_eq!(request.attachment_ids, ["att_agentdoc_1"]);
    assert_eq!(
        request.content["legacy_attachments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let text = request.content["blocks"][0]["text"].as_str().unwrap();
    let decoded: serde_json::Value = serde_json::from_slice(
        &base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            text.strip_prefix("kordi-cloud-group:").unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded["message"]["text"], "Done");
    assert_eq!(decoded["message"]["attachments"][0]["name"], "plan.md");
}

#[test]
fn the_fallback_message_is_the_agents_and_answers_no_request() {
    let latest = json!({
        "kind": "group-message",
        "groupId": "session:group:g1",
        "groupSpaceId": "space_g1",
        "createdByAccountId": "acct_owner",
        "participants": [
            { "accountId": "acct_owner", "displayName": "Owner" },
            { "accountId": "acct_member", "displayName": "Member" }
        ],
    });
    let documents = [document()];
    let envelope = document_envelope(
        &latest,
        &DocumentMessage {
            conversation_id: Uuid::nil(),
            run_id: "run_a",
            session_id: "session:group:g1",
            owner_account_id: "acct_owner",
            agent_id: "cloud-agent:acct_owner",
            documents: &documents,
        },
        42,
    );
    assert_eq!(envelope["groupSpaceId"], "space_g1");
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], "cloud-agent:acct_owner");
    assert!(message.get("requestId").is_none() && message.get("replyToMessageId").is_none());
    assert_eq!(message["attachments"][0]["attachmentId"], "att_agentdoc_1");
}
