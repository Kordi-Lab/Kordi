//! Blocking: private to the blocker, ends the relationship, and refuses new
//! requests in both directions.
use super::*;

impl Harness {
    pub(crate) async fn block(&self, blocker: &Account, target: &str) -> (StatusCode, Value) {
        self.send(
            "PUT",
            &format!("/v1/cloud/blocks/{target}"),
            Some(&blocker.token),
            json!({}),
        )
        .await
    }

    async fn unblock(&self, blocker: &Account, target: &str) -> StatusCode {
        self.send(
            "DELETE",
            &format!("/v1/cloud/blocks/{target}"),
            Some(&blocker.token),
            Value::Null,
        )
        .await
        .0
    }

    async fn blocks(&self, account: &Account) -> Value {
        self.send("GET", "/v1/cloud/blocks", Some(&account.token), Value::Null)
            .await
            .1
    }

    pub(crate) async fn contact_ids(&self, account: &Account) -> Vec<String> {
        let (status, body) = self
            .send(
                "GET",
                "/v1/cloud/contacts",
                Some(&account.token),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["contacts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|contact| contact["accountId"].as_str().map(str::to_string))
            .collect()
    }

    pub(crate) async fn contact_rows(&self, a: &Account, b: &Account) -> i64 {
        query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM cloud_contacts \
             WHERE (account_id = $1 AND peer_account_id = $2) \
                OR (account_id = $2 AND peer_account_id = $1)",
        )
        .bind(&a.id)
        .bind(&b.id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .0
    }

    async fn request_status(&self, request_id: &str) -> Option<String> {
        query_as::<_, (String,)>("SELECT status FROM cloud_contact_requests WHERE request_id = $1")
            .bind(request_id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|(status,)| status)
    }

    async fn directory_events(&self, account: &Account) -> Vec<(String, String)> {
        let rows: Vec<(Value,)> = query_as(
            "SELECT payload FROM cloud_chat_user_sync_events \
             WHERE account_id = $1 AND event_type = 'account.directory.changed' \
             ORDER BY stream_seq",
        )
        .bind(&account.id)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter()
            .filter_map(|(payload,)| {
                Some((
                    payload["accountId"].as_str()?.to_string(),
                    payload["reason"].as_str()?.to_string(),
                ))
            })
            .collect()
    }

    async fn send_contact_request(&self, from: &Account, to: &Account) -> (StatusCode, Value) {
        self.send(
            "POST",
            "/v1/cloud/contacts/requests",
            Some(&from.token),
            json!({ "peerAccountId": to.id }),
        )
        .await
    }
}

#[tokio::test]
async fn blocking_ends_the_relationship_and_decides_pending_requests_silently() {
    let Some(h) = harness().await else { return };
    let a = h.signup("Block A").await;
    let b = h.signup("Block B").await;
    let c = h.signup("Block C").await;
    let d = h.signup("Block D").await;
    h.request_contact(&a, &b, true).await;
    let inbound = h.request_contact(&c, &a, false).await;
    let outbound = h.request_contact(&a, &d, false).await;

    let (status, body) = h.block(&a, &b.id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removedContact"], true);
    assert_eq!(body["block"]["accountId"], b.id.as_str());
    assert_eq!(h.contact_rows(&a, &b).await, 0);
    assert!(!h.contact_ids(&a).await.contains(&b.id));
    assert!(!h.contact_ids(&b).await.contains(&a.id));
    assert_eq!(
        h.directory_events(&a).await,
        vec![(b.id.clone(), "blocked".to_string())]
    );
    assert!(
        !h.directory_events(&b)
            .await
            .iter()
            .any(|(_, reason)| reason == "blocked"),
        "the blocked account is never told"
    );

    let (status, repeated) = h.block(&a, &b.id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated["removedContact"], false);
    assert_eq!(repeated["block"]["blockedAt"], body["block"]["blockedAt"]);

    assert_eq!(h.block(&a, &c.id).await.0, StatusCode::OK);
    assert_eq!(h.block(&a, &d.id).await.0, StatusCode::OK);
    assert_eq!(
        h.request_status(&inbound).await.as_deref(),
        Some("rejected")
    );
    assert_eq!(
        h.request_status(&outbound).await,
        None,
        "the blocker's own pending request is removed"
    );

    let listed = h.blocks(&a).await;
    let rows = listed["blocks"].as_array().unwrap();
    let ids: Vec<&str> = rows
        .iter()
        .map(|row| row["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![d.id.as_str(), c.id.as_str(), b.id.as_str()]);
    let mut keys: Vec<&str> = rows[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "accountId",
            "avatarUrl",
            "blockedAt",
            "displayName",
            "kordiId"
        ]
    );
    assert!(!rows[0]["kordiId"].as_str().unwrap().is_empty());
    assert_eq!(h.blocks(&b).await["blocks"], json!([]));
}

#[tokio::test]
async fn requests_are_refused_both_ways_until_unblocked_and_contacts_stay_removed() {
    let Some(h) = harness().await else { return };
    let a = h.signup("Direction A").await;
    let b = h.signup("Direction B").await;
    h.request_contact(&a, &b, true).await;
    assert_eq!(h.block(&a, &b.id).await.0, StatusCode::OK);

    let (status, body) = h.send_contact_request(&b, &a).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], "contact_request_unavailable");
    let (status, body) = h.send_contact_request(&a, &b).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "blocked_account");
    let (status, body) = h
        .send(
            "POST",
            "/v1/cloud/contacts",
            Some(&b.token),
            json!({ "peerAccountId": a.id }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(h.contact_rows(&a, &b).await, 0);

    assert_eq!(h.unblock(&a, &b.id).await, StatusCode::NO_CONTENT);
    assert_eq!(h.unblock(&a, &b.id).await, StatusCode::NO_CONTENT);
    assert_eq!(h.contact_rows(&a, &b).await, 0, "unblocking adds nobody");
    assert_eq!(h.directory_events(&a).await.last().unwrap().1, "unblocked");
    let (status, _) = h.send_contact_request(&b, &a).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn self_service_and_unknown_accounts_cannot_be_blocked() {
    let Some(h) = harness().await else { return };
    let account = h.signup("Invalid blocker").await;
    let service = h.signup("Service owner").await;
    query(
        "INSERT INTO cloud_agent_definitions(agent_id, owner_account_id, status, name, role, \
         system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
         avatar_renderer_version, avatar_version, avatar_updated_at, is_system_managed) \
         VALUES ($1, $2, 'active', 'Service', 'support', 'test', 'test', 'test', 'generated', \
         'thumbs', $1, 'test', 1, 'test', TRUE)",
    )
    .bind(format!("cloud_agent_{}", Uuid::new_v4().simple()))
    .bind(&service.id)
    .execute(&h.pool)
    .await
    .unwrap();

    for (target, status, code) in [
        (account.id.as_str(), StatusCode::BAD_REQUEST, "self_block"),
        (
            service.id.as_str(),
            StatusCode::BAD_REQUEST,
            "cannot_block_service",
        ),
        (
            "acct_kordi_system",
            StatusCode::BAD_REQUEST,
            "cannot_block_service",
        ),
        (
            "acct_missing_account",
            StatusCode::NOT_FOUND,
            "account_missing",
        ),
    ] {
        let (actual, body) = h.block(&account, target).await;
        assert_eq!(
            (actual, body["errorCode"].as_str()),
            (status, Some(code)),
            "{target}"
        );
    }
    assert_eq!(h.blocks(&account).await["blocks"], json!([]));
}

#[tokio::test]
async fn accepting_while_the_requester_blocks_never_leaves_contact_rows() {
    let Some(h) = harness().await else { return };
    for round in 0..6 {
        let a = h.signup("Race A").await;
        let b = h.signup("Race B").await;
        let request_id = h.request_contact(&a, &b, false).await;
        let accept = format!("/v1/cloud/contacts/requests/{request_id}/accept");
        let ((accepted, _), (blocked, block_body)) = tokio::join!(
            h.send("POST", &accept, Some(&b.token), Value::Null),
            h.block(&a, &b.id),
        );
        assert_eq!(blocked, StatusCode::OK, "round {round}");
        assert_eq!(h.contact_rows(&a, &b).await, 0, "round {round}");
        if accepted == StatusCode::OK {
            assert_eq!(block_body["removedContact"], true, "round {round}");
        } else {
            assert!(accepted.is_client_error(), "round {round}: {accepted}");
        }
    }
    let a = h.signup("After A").await;
    let b = h.signup("After B").await;
    let request_id = h.request_contact(&a, &b, false).await;
    assert_eq!(h.block(&b, &a.id).await.0, StatusCode::OK);
    let (status, _) = h
        .send(
            "POST",
            &format!("/v1/cloud/contacts/requests/{request_id}/accept"),
            Some(&b.token),
            Value::Null,
        )
        .await;
    assert!(status.is_client_error(), "{status}");
    assert_eq!(h.contact_rows(&a, &b).await, 0);
}
