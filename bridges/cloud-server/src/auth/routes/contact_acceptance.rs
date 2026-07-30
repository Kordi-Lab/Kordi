use super::*;

// ---------- helpers ----------

/// Shared body of "accept this pending request" used by both the
/// explicit POST and the "mutual reachout" auto-accept inside
/// `send_contact_request`. `from_id` and `to_id` are the request's
/// from / to (NOT relative to the caller).
pub(super) async fn finalize_request_acceptance(
    state: &Arc<ServerState>,
    session: &CloudSession,
    pool: &PgPool,
    request_id: &str,
    from_id: &str,
    to_id: &str,
) -> Response {
    let now = Utc::now().to_rfc3339();

    let mut tx = match pool.begin().await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if query(
        "UPDATE cloud_contact_requests \
         SET status = 'accepted', decided_at = $1 \
         WHERE request_id = $2 AND status = 'pending'",
    )
    .bind(&now)
    .bind(request_id)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not accept request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    // Symmetric contact rows. ON CONFLICT DO NOTHING keeps the
    // operation idempotent if either side somehow already had the row.
    for (owner, peer) in [(from_id, to_id), (to_id, from_id)] {
        if query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (account_id, peer_account_id) DO NOTHING",
        )
        .bind(owner)
        .bind(peer)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record contact.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    // Auto-hello: the acceptor (to_id) greets the original requester
    // (from_id) so a freshly accepted contact pair has at least one
    // message in their conversation history. We capture the id +
    // body so we can fire a message.arrived NATS event after commit.
    let hello_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let hello_body = "👋 Hi! Thanks for adding me — happy to connect.";
    let hello_session_id = cloud_direct_person_session_id(from_id, to_id);
    if query(
        "INSERT INTO cloud_messages \
         (message_id, from_account_id, to_account_id, body, created_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&hello_id)
    .bind(to_id)
    .bind(from_id)
    .bind(hello_body)
    .bind(&now)
    .bind(&hello_session_id)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record hello message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let (acceptor_hello, requester_hello) =
        contact_acceptance_hello_sync_summaries(&hello_id, from_id, to_id, hello_body, &now);
    for (account_id, peer_account_id, summary) in [
        (to_id, from_id, &acceptor_hello),
        (from_id, to_id, &requester_hello),
    ] {
        if query(
            "INSERT INTO cloud_sync_events \
             (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(account_id)
        .bind("message.upsert")
        .bind(peer_account_id)
        .bind(&summary.message_id)
        .bind(message_sync_payload(summary))
        .bind(&now)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record hello sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit acceptance.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.accepted",
        serde_json::json!({ "request_id": request_id, "peer": from_id }),
    )
    .await;

    // Fire the lifecycle events: one accept-notification to the
    // original requester, plus contact.added on both sides so any
    // open WS on either account refreshes its contacts list, plus
    // the auto-hello message.arrived so the chat surface lights up.
    {
        let events = state.events().clone();
        let request_id = request_id.to_string();
        let from = from_id.to_string();
        let to = to_id.to_string();
        let hello_id = hello_id.clone();
        let hello_body = hello_body.to_string();
        let now = now.clone();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Accepted,
                    &request_id,
                    &from,
                    &to,
                )
                .await;
            events.publish_contact_added(&from, &to).await;
            events.publish_contact_added(&to, &from).await;
            // Hello message: from = acceptor (to_id in request terms),
            // recipient = requester (from_id). The recipient is the
            // one who needs the live WS frame.
            events
                .publish_message_arrived(crate::events::MessageArrived {
                    message_id: &hello_id,
                    from_account_id: &to,
                    to_account_id: &from,
                    body: &hello_body,
                    created_at: &now,
                    session_id: Some(&hello_session_id),
                    attachments: serde_json::json!([]),
                })
                .await;
        });
    }

    // Build the response. The caller may be either the requester (in
    // the mutual-reachout path) or the recipient — figure out the
    // counterpart from `session.account_id`.
    let counterpart_id = if from_id == session.account_id {
        to_id.to_string()
    } else {
        from_id.to_string()
    };
    let direction = if from_id == session.account_id {
        "outgoing"
    } else {
        "incoming"
    };
    let counterpart = account_response_row(pool, &counterpart_id)
        .await
        .ok()
        .flatten()
        .map(account_to_summary);

    let summary = ContactRequestSummary {
        request_id: request_id.to_string(),
        from_account_id: from_id.to_string(),
        to_account_id: to_id.to_string(),
        status: "accepted".into(),
        direction: direction.into(),
        message: None,
        created_at: now.clone(),
        decided_at: Some(now),
        counterpart,
    };
    let hello_message = if session.account_id == to_id {
        Some(acceptor_hello)
    } else if session.account_id == from_id {
        Some(requester_hello)
    } else {
        None
    };
    (
        StatusCode::OK,
        Json(ContactRequestResponse {
            request: summary,
            hello_message,
        }),
    )
        .into_response()
}

pub(super) fn account_to_summary(account: AccountResponse) -> ContactSummary {
    ContactSummary {
        account_id: account.account_id,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        node_id: account.node_id,
        created_at: String::new(),
    }
}

// ---------- Cloud messages (1:1 peer chat) ----------
