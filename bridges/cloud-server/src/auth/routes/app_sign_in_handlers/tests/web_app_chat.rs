//! Real cookie authentication and durable chat through the complete server router.
use super::*;

const PASSWORD: &str = "synthetic-Web-chat-Password-42!";

async fn login_browser(harness: &Harness) -> WebAccount {
    let fixture = harness.web_account().await;
    let password_hash =
        crate::auth::password::hash_password(PASSWORD, PasswordHasherConfig::for_tests()).unwrap();
    query("UPDATE cloud_accounts SET password_hash=$1 WHERE account_id=$2")
        .bind(password_hash)
        .bind(&fixture.account_id)
        .execute(&harness.pool)
        .await
        .unwrap();
    let (status, body, headers) = harness
        .send_with(
            "POST",
            "/v1/cloud/auth/web/login",
            vec![("Origin".to_string(), crate::distribution::public_origin())],
            Some((
                "application/json",
                serde_json::json!({
                    "email": format!("{}@example.test", fixture.account_id), "password": PASSWORD,
                })
                .to_string(),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["session"].get("token").is_none());
    let prefix = format!("{WEB_SESSION_COOKIE}=");
    let token = headers
        .get_all("set-cookie")
        .iter()
        .find_map(|value| {
            value
                .to_str()
                .ok()?
                .strip_prefix(&prefix)?
                .split(';')
                .next()
                .map(str::to_string)
        })
        .expect("web login must issue the HttpOnly session cookie");
    assert_eq!(body["account"]["accountId"], fixture.account_id);
    WebAccount {
        account_id: fixture.account_id,
        web_token: token,
    }
}

fn browser_headers(account: &WebAccount) -> Vec<(String, String)> {
    let mut headers = web_headers(&account.web_token);
    headers.push((
        "X-Kordi-Web-Account".to_string(),
        account.account_id.clone(),
    ));
    headers
}

async fn browser_json(
    harness: &Harness,
    account: &WebAccount,
    uri: &str,
    body: Value,
) -> (StatusCode, Value) {
    let (status, body, _) = harness
        .send_with(
            "POST",
            uri,
            browser_headers(account),
            Some(("application/json", body.to_string())),
        )
        .await;
    (status, body)
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn two_browser_cookies_exchange_durable_chat_through_the_full_router() {
    let mut harness = harness().await;
    harness.app = crate::server::router(Arc::new(ServerState::new(
        harness.pool.clone(),
        crate::events::EventBus::noop(),
    )));
    let sender = login_browser(&harness).await;
    let recipient = login_browser(&harness).await;
    let outsider = login_browser(&harness).await;
    assert_ne!(sender.web_token, recipient.web_token);

    // Build the relationship through the same contact API the clients use.
    let (status, request) = browser_json(
        &harness,
        &sender,
        "/v1/cloud/contacts/requests",
        serde_json::json!({ "peerAccountId": recipient.account_id }),
    )
    .await;
    assert!(status.is_success(), "{status} {request}");
    let request_id = request["request"]["requestId"]
        .as_str()
        .expect("contact request ID");
    let (status, accepted) = browser_json(
        &harness,
        &recipient,
        &format!("/v1/cloud/contacts/requests/{request_id}/accept"),
        serde_json::json!({}),
    )
    .await;
    assert!(status.is_success(), "{status} {accepted}");

    let session_id =
        crate::auth::routes::direct_person_session_id(&sender.account_id, &recipient.account_id);
    let create = |peer: &str| {
        serde_json::json!({
            "client_operation_id": uuid::Uuid::now_v7(), "kind": "direct",
            "client_session_id": session_id, "member_account_ids": [peer],
        })
    };
    let (status, created) = browser_json(
        &harness,
        &sender,
        "/v2/chat/conversations",
        create(&recipient.account_id),
    )
    .await;
    assert!(status.is_success(), "{status} {created}");
    let conversation_id = created["conversation"]["id"].as_str().unwrap();
    let (status, selected) = browser_json(
        &harness,
        &recipient,
        "/v2/chat/conversations",
        create(&sender.account_id),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{selected}");
    assert_eq!(selected["conversation"]["id"], conversation_id);

    let messages_uri = format!("/v2/chat/conversations/{conversation_id}/messages");
    let (status, initial, _) = harness
        .send_with("GET", &messages_uri, browser_headers(&recipient), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{initial}");
    let initial_count = initial["messages"].as_array().unwrap().len();
    let outgoing = serde_json::json!({
        "client_message_id": uuid::Uuid::now_v7(), "kind": "text",
        "content": { "schema": 1, "blocks": [{ "type": "text", "text": "Real browser cookie message" }] },
        "attachment_ids": [], "reply_to_message_id": null,
    });
    let missing_csrf = browser_headers(&sender)
        .into_iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case(WEB_CSRF_HEADER))
        .collect();
    let (status, rejected, _) = harness
        .send_with(
            "POST",
            &messages_uri,
            missing_csrf,
            Some(("application/json", outgoing.to_string())),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{rejected}");
    assert_eq!(rejected["error"], "csrf_token_invalid");

    let (status, sent) = browser_json(&harness, &sender, &messages_uri, outgoing.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{sent}");
    let (status, retried) = browser_json(&harness, &sender, &messages_uri, outgoing).await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["message"]["id"], sent["message"]["id"]);

    let (status, history, _) = harness
        .send_with("GET", &messages_uri, browser_headers(&recipient), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(
        messages.len(),
        initial_count + 1,
        "CSRF refusal and retry must not duplicate messages"
    );
    let message = messages
        .iter()
        .find(|message| message["id"] == sent["message"]["id"])
        .unwrap();
    assert_eq!(message["sender_account_id"], sender.account_id);
    assert_eq!(
        message["content"]["blocks"][0]["text"],
        "Real browser cookie message"
    );

    let (status, denied, _) = harness
        .send_with("GET", &messages_uri, browser_headers(&outsider), None)
        .await;
    assert!(
        matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
        "{status} {denied}"
    );
    assert!(!denied.to_string().contains("Real browser cookie message"));
}
