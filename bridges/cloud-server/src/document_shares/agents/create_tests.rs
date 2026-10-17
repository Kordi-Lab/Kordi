use serde_json::json;
use uuid::Uuid;

use super::group_message::{document_envelope, DocumentMessage};
use super::{derived_ids, file_name_for, parse, NewDocument};
use crate::document_shares::agents::tools::ToolError;

#[test]
fn titles_become_safe_file_names() {
    assert_eq!(file_name_for("Launch plan", "md"), "Launch plan.md");
    assert_eq!(
        file_name_for("Q3: plan / budget?", "md"),
        "Q3 plan budget.md"
    );
    assert_eq!(file_name_for("notes.md", "md"), "notes.md");
    assert_eq!(file_name_for("Report.HTML", "html"), "Report.html");
    assert_eq!(file_name_for("../../etc/passwd", "md"), "etc passwd.md");
    assert_eq!(file_name_for("...", "md"), "Document.md");
    let long = "x".repeat(300);
    assert_eq!(file_name_for(&long, "md").len(), 120 + 3);
}

#[test]
fn arguments_are_checked() {
    let document = parse(&json!({ "title": "  Launch   plan ", "content": "# Launch\n" })).unwrap();
    assert_eq!(
        document,
        NewDocument {
            title: "Launch plan".into(),
            file_name: "Launch plan.md".into(),
            content_type: "text/markdown",
            content: "# Launch\n".into(),
        }
    );
    let html =
        parse(&json!({ "title": "Page", "content": "<h1>x</h1>", "format": "html" })).unwrap();
    assert_eq!(
        (html.content_type, html.file_name.as_str()),
        ("text/html", "Page.html")
    );
    assert_eq!(html.format(), "html");

    let too_big = "a".repeat(super::MAX_TOOL_TEXT_BYTES + 1);
    for args in [
        json!({ "content": "x" }),
        json!({ "title": "", "content": "x" }),
        json!({ "title": "t".repeat(201), "content": "x" }),
        json!({ "title": "Plan", "content": "  \n" }),
        json!({ "title": "Plan", "content": "x", "format": "docx" }),
        json!({ "title": "Plan", "content": too_big }),
    ] {
        assert!(matches!(parse(&args), Err(ToolError::Invalid(_))), "{args}");
    }
}

#[test]
fn ids_are_stable_for_a_retry_and_differ_per_run_and_content() {
    let document = parse(&json!({ "title": "Plan", "content": "# Plan\n" })).unwrap();
    let first = derived_ids("run_a", &document);
    assert_eq!(first, derived_ids("run_a", &document));
    assert_ne!(first, derived_ids("run_b", &document));
    let other = parse(&json!({ "title": "Plan", "content": "# Plan 2\n" })).unwrap();
    assert_ne!(first.0, derived_ids("run_a", &other).0);
    assert!(first.0.starts_with("att_agentdoc_"));
}

#[test]
fn the_document_message_is_the_agents_message_and_answers_no_request() {
    let document = parse(&json!({ "title": "Plan", "content": "# Plan\n" })).unwrap();
    let latest = json!({
        "kind": "group-message",
        "groupId": "session:group:g1",
        "groupSpaceId": "space_g1",
        "createdByAccountId": "acct_owner",
        "participants": [
            { "accountId": "acct_owner", "displayName": "Owner" },
            { "accountId": "acct_member", "displayName": "Member" }
        ],
        "message": { "id": "m0", "senderAccountId": "acct_member", "text": "@Kordi make a plan",
                     "requestId": "m0" }
    });
    let envelope = document_envelope(
        &latest,
        &DocumentMessage {
            conversation_id: Uuid::nil(),
            client_message_id: Uuid::nil(),
            session_id: "session:group:g1",
            owner_account_id: "acct_owner",
            agent_id: "cloud-agent:acct_owner",
            attachment_id: "att_agentdoc_1",
            document: &document,
        },
        42,
    );
    assert_eq!(envelope["groupSpaceId"], "space_g1");
    assert_eq!(envelope["actor"]["displayName"], "Owner");
    assert_eq!(envelope["participants"].as_array().unwrap().len(), 2);
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], "cloud-agent:acct_owner");
    assert_eq!(message["deliveryState"], "complete");
    assert!(message.get("requestId").is_none() && message.get("replyToMessageId").is_none());
    assert_eq!(message["attachments"][0]["attachmentId"], "att_agentdoc_1");
    assert_eq!(message["attachments"][0]["name"], "Plan.md");
    assert_eq!(message["attachments"][0]["mimeType"], "text/markdown");
}
