//! The server copies exactly the messages a person chose, and only from a
//! conversation they are still in.
use super::*;

async fn evidence(pool: &PgPool, report_id: &Value) -> Value {
    query_as::<_, (Value,)>("SELECT evidence FROM cloud_abuse_reports WHERE report_id = $1")
        .bind(report_id.as_str().unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

fn message_report(conversation: Uuid, ids: &[Uuid]) -> Value {
    json!({ "clientReportId": Uuid::new_v4(), "reason": "harassment",
            "conversationId": conversation, "messageIds": ids })
}

fn rejected(result: (StatusCode, Value)) -> bool {
    result.0 == StatusCode::BAD_REQUEST && result.1["errorCode"] == "invalid_report_evidence"
}

#[tokio::test]
async fn message_reports_copy_the_chosen_messages_verbatim() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Message reporter").await;
    let reported = h.signup("Message sender").await;
    h.request_contact(&reporter, &reported, true).await;
    let chat = h.direct_chat(&reporter, &reported).await;
    let unrelated = h
        .message(&reported, chat, "an earlier message nobody chose")
        .await;
    let first = h.message(&reported, chat, "first unkind message").await;
    let file = photo(&h.pool, &reported).await;
    let second = h
        .message_with(&reported, chat, photo_content(&file), vec![file.clone()])
        .await;
    let own = h.message(&reporter, chat, "please stop").await;

    // The reported account is inferred from the first message not from the reporter.
    let (status, body) = h
        .report(&reporter, message_report(chat, &[own, second, first]))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["report"]["targetKind"], "message");
    assert_eq!(body["report"]["evidenceMessageCount"], 3);
    assert_eq!(body["report"]["reportedDisplayName"], "Message sender");
    let (reported_id,): (Option<String>,) =
        query_as("SELECT reported_account_id FROM cloud_abuse_reports WHERE report_id = $1")
            .bind(body["report"]["reportId"].as_str().unwrap())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(reported_id.as_deref(), Some(reported.id.as_str()));
    let evidence = evidence(&h.pool, &body["report"]["reportId"]).await;
    assert_eq!(evidence["schema"], 1);
    assert_eq!(evidence["conversation"]["conversationId"], json!(chat));
    assert_eq!(evidence["conversation"]["kind"], "direct");
    assert_eq!(evidence["conversation"]["activeMemberCount"], 2);
    assert!(evidence["contactRequest"].is_null());
    let messages = evidence["messages"].as_array().unwrap();
    let ids = messages
        .iter()
        .map(|m| m["messageId"].clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![json!(first), json!(second), json!(own)]);
    assert!(!ids.contains(&json!(unrelated)));
    let stored: Vec<(Uuid, Value)> =
        query_as("SELECT message_id, content FROM cloud_chat_messages WHERE message_id = ANY($1)")
            .bind(vec![first, second])
            .fetch_all(&h.pool)
            .await
            .unwrap();
    for (id, content) in stored {
        let copied = messages
            .iter()
            .find(|m| m["messageId"] == json!(id))
            .unwrap();
        assert_eq!(copied["content"], content, "content is copied verbatim");
        assert_eq!(copied["senderAccountId"], reported.id.as_str());
    }
    let attachment = &messages[1]["attachments"][0];
    assert_eq!(
        attachment,
        &json!({ "attachmentId": file, "contentType": "image/png", "sizeBytes": 120,
                 "sha256Hex": "ab".repeat(32) })
    );
    assert_eq!(messages[0]["attachments"], json!([]));
}

#[tokio::test]
async fn evidence_must_come_from_a_conversation_the_reporter_is_still_in() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Careful reporter").await;
    let reported = h.signup("Sender").await;
    let other = h.signup("Other").await;
    h.request_contact(&reporter, &reported, true).await;
    h.request_contact(&reported, &other, true).await;
    let chat = h.direct_chat(&reporter, &reported).await;
    let elsewhere = h.direct_chat(&reported, &other).await;
    let theirs = h.message(&reported, chat, "message").await;
    let own = h.message(&reporter, chat, "reply").await;
    let foreign = h.message(&reported, elsewhere, "not in this chat").await;
    let deleted = h.message(&reported, chat, "deleted later").await;
    chat_store::delete_message(&h.pool, &reported.id, chat, deleted, true)
        .await
        .unwrap();

    for ids in [
        vec![foreign],
        vec![theirs, foreign],
        vec![deleted],
        vec![Uuid::now_v7()],
    ] {
        assert!(
            rejected(h.report(&reporter, message_report(chat, &ids)).await),
            "{ids:?}"
        );
    }
    // Only the reporter's own messages: nobody to report.
    let (status, body) = h.report(&reporter, message_report(chat, &[own])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["message"],
        "Choose at least one message from the person you're reporting."
    );
    // A named account must have written one of the messages.
    let mut named = message_report(chat, &[theirs]);
    named["reportedAccountId"] = json!(other.id);
    assert!(rejected(h.report(&reporter, named).await));
    // Someone outside the conversation cannot report from it.
    assert!(rejected(
        h.report(&other, message_report(chat, &[theirs])).await
    ));
    // A positive control: the same message is reportable by the member.
    let (status, _) = h.report(&reporter, message_report(chat, &[theirs])).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn contact_requests_are_included_only_when_sent_to_the_reporter() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Request recipient").await;
    let sender = h.signup("Request sender").await;
    let bystander = h.signup("Bystander").await;
    let request_id = h.request_contact(&sender, &reporter, false).await;

    let mut body = account_report(&sender);
    body["contactRequestId"] = json!(request_id);
    let (status, created) = h.report(&reporter, body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let evidence = evidence(&h.pool, &created["report"]["reportId"]).await;
    assert_eq!(evidence["contactRequest"]["requestId"], request_id.as_str());
    assert_eq!(evidence["contactRequest"]["status"], "pending");
    assert_eq!(evidence["messages"], json!([]));
    assert!(evidence["conversation"].is_null());

    let mut wrong_sender = account_report(&bystander);
    wrong_sender["contactRequestId"] = json!(request_id);
    assert!(rejected(h.report(&reporter, wrong_sender).await));
    let mut not_received = account_report(&reporter);
    not_received["contactRequestId"] = json!(request_id);
    assert!(rejected(h.report(&sender, not_received).await));
}

/// Accepts every object deletion, so the removal job can finish a file.
struct AcceptingObjects;

#[async_trait::async_trait]
impl kordi_cloud_server::chat_sync::removal::ObjectStoreDeleter for AcceptingObjects {
    async fn delete_object(
        &self,
        _object_key: &str,
    ) -> Result<(), kordi_cloud_server::chat_sync::removal::ObjectDeleteError> {
        Ok(())
    }
}

/// A report is moderation evidence. The sender deleting a reported message for
/// everyone, and the removal job that follows, leave the report's copy as it
/// is until report retention removes it, as `docs/data-deletion.md` says.
#[tokio::test]
async fn deleting_a_reported_message_for_everyone_leaves_the_report_copy() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Deletion reporter").await;
    let reported = h.signup("Deleting sender").await;
    h.request_contact(&reporter, &reported, true).await;
    let chat = h.direct_chat(&reporter, &reported).await;
    let text = h.message(&reported, chat, "an unkind message").await;
    let file = photo(&h.pool, &reported).await;
    let with_photo = h
        .message_with(&reported, chat, photo_content(&file), vec![file.clone()])
        .await;
    let (status, body) = h
        .report(&reporter, message_report(chat, &[text, with_photo]))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let report_id = &body["report"]["reportId"];
    let before = evidence(&h.pool, report_id).await;

    for message in [text, with_photo] {
        chat_store::delete_message(&h.pool, &reported.id, chat, message, true)
            .await
            .expect("delete for everyone");
    }
    let jobs: Vec<(Uuid,)> =
        query_as("SELECT job_id FROM cloud_content_removal_jobs WHERE message_id = ANY($1)")
            .bind(vec![text, with_photo])
            .fetch_all(&h.pool)
            .await
            .unwrap();
    let jobs = jobs.into_iter().map(|(id,)| id).collect::<Vec<_>>();
    assert_eq!(jobs.len(), 2);
    for _ in 0..50 {
        let ran = kordi_cloud_server::chat_sync::removal::run_jobs(
            &h.pool,
            Some(&AcceptingObjects),
            &jobs,
        )
        .await
        .unwrap();
        if ran == 0 {
            break;
        }
    }
    // Chat storage no longer holds the text or the file's hash.
    let (completed,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_content_removal_jobs WHERE job_id = ANY($1) AND completed_at IS NOT NULL",
    )
    .bind(&jobs)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(completed, 2, "the removal jobs finished");
    let stored: Vec<(Value,)> =
        query_as("SELECT content FROM cloud_chat_messages WHERE message_id = ANY($1)")
            .bind(vec![text, with_photo])
            .fetch_all(&h.pool)
            .await
            .unwrap();
    assert!(stored
        .iter()
        .all(|(content,)| !content.to_string().contains("unkind")
            && !content.to_string().contains(&file)));
    let (hash,): (Option<String>,) =
        query_as("SELECT sha256_hex FROM cloud_attachments WHERE attachment_id = $1")
            .bind(&file)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(hash.is_none(), "chat storage clears the file's hash");

    // The report keeps the text and the attachment metadata, hash included.
    let after = evidence(&h.pool, report_id).await;
    assert_eq!(after, before);
    assert!(after.to_string().contains("an unkind message"));
    assert_eq!(
        after["messages"][1]["attachments"][0]["sha256Hex"],
        "ab".repeat(32)
    );
}
