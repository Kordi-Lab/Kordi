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

    let acceptance_update = query(
        "UPDATE cloud_contact_requests \
         SET status = 'accepted', decided_at = $1 \
         WHERE request_id = $2 AND status = 'pending'",
    )
    .bind(&now)
    .bind(request_id)
    .execute(&mut *tx)
    .await;
    let acceptance_update = match acceptance_update {
        Ok(result) => result,
        Err(_) => {
            return err(
                "server_error",
                "Could not accept request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let newly_accepted = acceptance_update.rows_affected() > 0;
    let decided_at = if newly_accepted {
        now.clone()
    } else {
        let existing_decision: Option<(String, Option<String>)> = match query_as(
            "SELECT status, decided_at FROM cloud_contact_requests \
             WHERE request_id = $1 AND from_account_id = $2 AND to_account_id = $3",
        )
        .bind(request_id)
        .bind(from_id)
        .bind(to_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not load contact request decision.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
        match existing_decision {
            Some((status, decided_at)) if status == "accepted" => {
                decided_at.unwrap_or_else(|| now.clone())
            }
            _ => {
                return err(
                    "request_decided",
                    "Contact request has already been decided.",
                    StatusCode::CONFLICT,
                );
            }
        }
    };

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
    let proposed_hello_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let hello_client_message_id = format!("contact-acceptance:{request_id}:hello");
    let hello_body = "👋 Hi! Thanks for adding me — happy to connect.";
    let hello_session_id = cloud_direct_person_session_id(from_id, to_id);
    let hello = persist_cloud_message_in_transaction(
        &mut tx,
        PersistCloudMessageInput {
            message_id: &proposed_hello_id,
            from_account_id: to_id,
            to_account_id: from_id,
            client_message_id: Some(&hello_client_message_id),
            body: hello_body,
            session_id: Some(&hello_session_id),
            created_at: &now,
            delivered_at: &now,
            read_at: None,
            attachments: &[],
            claim_legacy_self_replay: false,
            legacy_self_replay_lock_id: None,
        },
    )
    .await;
    let (hello_id, hello_created_at, hello_inserted) = match hello {
        Ok(outcome) => (
            outcome.message.message_id,
            outcome.message.created_at,
            outcome.inserted,
        ),
        Err(_) => {
            return err(
                "server_error",
                "Could not record hello message.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let (acceptor_hello, requester_hello) = contact_acceptance_hello_sync_summaries(
        &hello_id,
        from_id,
        to_id,
        hello_body,
        &hello_created_at,
    );

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
    if newly_accepted || hello_inserted {
        let events = state.events().clone();
        let request_id = request_id.to_string();
        let from = from_id.to_string();
        let to = to_id.to_string();
        let hello_id = hello_id.clone();
        let hello_body = hello_body.to_string();
        let hello_created_at = hello_created_at.clone();
        tokio::spawn(async move {
            if newly_accepted {
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
            }
            // Hello message: from = acceptor (to_id in request terms),
            // recipient = requester (from_id). The recipient is the
            // one who needs the live WS frame.
            if hello_inserted {
                events
                    .publish_message_arrived(crate::events::MessageArrived {
                        message_id: &hello_id,
                        from_account_id: &to,
                        to_account_id: &from,
                        body: &hello_body,
                        created_at: &hello_created_at,
                        session_id: Some(&hello_session_id),
                        attachments: serde_json::json!([]),
                    })
                    .await;
            }
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
        decided_at: Some(decided_at),
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
        contact_id: None,
        contact_kind: None,
        account_id: account.account_id,
        kordi_id: Some(account.kordi_id),
        display_name: account.display_name,
        subtitle: None,
        avatar_url: account.avatar_url,
        node_id: account.node_id,
        created_at: String::new(),
        locked: false,
        target_cloud_agent_id: None,
        target_cloud_agent_name: None,
        target_cloud_agent_owner_account_id: None,
        target_cloud_agent_owner_name: None,
        support_ticket_enabled: false,
    }
}

// ---------- Cloud messages (1:1 peer chat) ----------
