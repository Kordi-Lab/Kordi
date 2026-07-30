use super::*;

// ---------- Contact request flow ----------

/// `POST /v1/cloud/contacts/requests` — send a contact request.
///
/// If there's already an *incoming* pending request from the same peer
/// (i.e. they asked us first), this short-circuits to acceptance and
/// makes the relationship mutual — useful when both sides reach out
/// concurrently. Otherwise we insert a fresh pending request and fire
/// the corresponding NATS event so the recipient's open WebSocket
/// learns about it live.
pub(super) async fn send_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<SendContactRequestBody>,
) -> Response {
    let peer = req.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if peer == session.account_id {
        return err(
            "self_contact",
            "You cannot send a contact request to yourself.",
            StatusCode::BAD_REQUEST,
        );
    }
    let message = req
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(280).collect::<String>());

    let pool = state.db_pool();

    // Peer must exist.
    let peer_account = match account_response_row(pool, &peer).await {
        Ok(Some(account)) => account,
        Ok(None) => {
            return err(
                "account_missing",
                "No account found with that id.",
                StatusCode::NOT_FOUND,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // Already-accepted contact? Idempotent — just echo the existing
    // (or last) request row if there is one, otherwise a synthetic
    // "already accepted" placeholder.
    let already_contact: Option<(i32,)> = match query_as(
        "SELECT 1 FROM cloud_contacts \
         WHERE account_id = $1 AND peer_account_id = $2",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if already_contact.is_some() {
        return err(
            "already_contact",
            "You are already contacts.",
            StatusCode::CONFLICT,
        );
    }

    // If they already asked us — auto-accept.
    let inbound_pending: Option<(String, Option<String>, String)> = match query_as(
        "SELECT request_id, message, created_at \
         FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&peer)
    .bind(&session.account_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if let Some((request_id, _msg, _created_at)) = inbound_pending {
        return finalize_request_acceptance(
            &state,
            &session,
            pool,
            &request_id,
            &peer,
            &session.account_id,
        )
        .await;
    }

    // Outbound pending already? Idempotent — return it.
    let outbound_existing: Option<(String, String, Option<String>)> = match query_as(
        "SELECT request_id, created_at, message \
         FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if let Some((existing_id, created_at, existing_message)) = outbound_existing {
        let summary = ContactRequestSummary {
            request_id: existing_id,
            from_account_id: session.account_id.clone(),
            to_account_id: peer.clone(),
            status: "pending".into(),
            direction: "outgoing".into(),
            message: existing_message,
            created_at,
            decided_at: None,
            counterpart: Some(account_to_summary(peer_account)),
        };
        return (
            StatusCode::OK,
            Json(ContactRequestResponse {
                request: summary,
                hello_message: None,
            }),
        )
            .into_response();
    }

    // Insert a fresh request.
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_contact_requests \
         (request_id, from_account_id, to_account_id, status, message, created_at) \
         VALUES ($1, $2, $3, 'pending', $4, $5)",
    )
    .bind(&request_id)
    .bind(&session.account_id)
    .bind(&peer)
    .bind(message.as_deref())
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.sent",
        serde_json::json!({ "request_id": request_id, "peer": peer }),
    )
    .await;

    // Notify the peer's open WS via NATS.
    {
        let events = state.events().clone();
        let request_id = request_id.clone();
        let from = session.account_id.clone();
        let to = peer.clone();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Created,
                    &request_id,
                    &from,
                    &to,
                )
                .await;
        });
    }

    let summary = ContactRequestSummary {
        request_id,
        from_account_id: session.account_id.clone(),
        to_account_id: peer.clone(),
        status: "pending".into(),
        direction: "outgoing".into(),
        message,
        created_at: now,
        decided_at: None,
        counterpart: Some(account_to_summary(peer_account)),
    };
    (
        StatusCode::CREATED,
        Json(ContactRequestResponse {
            request: summary,
            hello_message: None,
        }),
    )
        .into_response()
}

/// `GET /v1/cloud/contacts/requests` — list pending requests touching
/// the caller, both incoming and outgoing. Decided requests are not
/// returned (they would clutter the UI inbox; querying history is a
/// separate concern).
pub(super) async fn list_contact_requests(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();

    let rows: Vec<ContactRequestRow> = match query_as(
        "SELECT r.request_id, r.from_account_id, r.to_account_id, r.status, \
                r.message, r.created_at, r.decided_at \
         FROM cloud_contact_requests r \
         WHERE r.status = 'pending' \
           AND (r.from_account_id = $1 OR r.to_account_id = $1) \
         ORDER BY r.created_at DESC",
    )
    .bind(&session.account_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let mut requests: Vec<ContactRequestSummary> = Vec::with_capacity(rows.len());
    for (request_id, from_id, to_id, status, message, created_at, decided_at) in rows {
        let (direction, counterpart_id) = if from_id == session.account_id {
            ("outgoing", to_id.clone())
        } else {
            ("incoming", from_id.clone())
        };
        let counterpart = account_response_row(pool, &counterpart_id)
            .await
            .ok()
            .flatten()
            .map(account_to_summary);
        requests.push(ContactRequestSummary {
            request_id,
            from_account_id: from_id,
            to_account_id: to_id,
            status,
            direction: direction.into(),
            message,
            created_at,
            decided_at,
            counterpart,
        });
    }

    Json(ContactRequestListResponse { requests }).into_response()
}

/// `POST /v1/cloud/contacts/requests/:id/accept` — only the recipient
/// (`to_account_id`) can accept.
pub(super) async fn accept_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();

    let row: Option<(String, String, String)> = match query_as(
        "SELECT from_account_id, to_account_id, status \
         FROM cloud_contact_requests WHERE request_id = $1",
    )
    .bind(&request_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some((from_id, to_id, status)) = row else {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if to_id != session.account_id {
        // Don't leak existence to non-recipients.
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    }
    if status != "pending" {
        return err(
            "request_decided",
            "Contact request has already been decided.",
            StatusCode::CONFLICT,
        );
    }

    finalize_request_acceptance(&state, &session, pool, &request_id, &from_id, &to_id).await
}

/// `POST /v1/cloud/contacts/requests/:id/reject`
pub(super) async fn reject_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();

    let row: Option<(String, String, String)> = match query_as(
        "SELECT from_account_id, to_account_id, status \
         FROM cloud_contact_requests WHERE request_id = $1",
    )
    .bind(&request_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some((from_id, to_id, status)) = row else {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if to_id != session.account_id {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    }
    if status != "pending" {
        return err(
            "request_decided",
            "Contact request has already been decided.",
            StatusCode::CONFLICT,
        );
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_contact_requests \
         SET status = 'rejected', decided_at = $1 \
         WHERE request_id = $2 AND status = 'pending'",
    )
    .bind(&now)
    .bind(&request_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not reject request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.rejected",
        serde_json::json!({ "request_id": request_id, "from": from_id }),
    )
    .await;

    // Notify the original requester.
    {
        let events = state.events().clone();
        let request_id_clone = request_id.clone();
        let from = from_id.clone();
        let to = to_id.clone();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Rejected,
                    &request_id_clone,
                    &from,
                    &to,
                )
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}
