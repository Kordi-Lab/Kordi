use super::*;

/// What sending or accepting a contact request produced: the status and body
/// the contacts route answers with, or the error response to send instead.
pub(crate) enum ContactOutcome {
    Done(StatusCode, Box<ContactRequestResponse>),
    Failed(Response),
}

impl IntoResponse for ContactOutcome {
    fn into_response(self) -> Response {
        match self {
            Self::Done(status, body) => (status, Json(*body)).into_response(),
            Self::Failed(response) => response,
        }
    }
}

fn database_error() -> ContactOutcome {
    ContactOutcome::Failed(err(
        "server_error",
        "Database error.",
        StatusCode::INTERNAL_SERVER_ERROR,
    ))
}

/// Sends a contact request from `session`'s account to `peer`, as
/// `POST /v1/cloud/contacts/requests` does.
///
/// If there's already an *incoming* pending request from the same peer
/// (i.e. they asked us first), this short-circuits to acceptance and
/// makes the relationship mutual — useful when both sides reach out
/// concurrently. Otherwise we insert a fresh pending request and fire
/// the corresponding NATS event so the recipient's open WebSocket
/// learns about it live.
pub(crate) async fn send_request(
    state: &Arc<ServerState>,
    rate_limiter: &CloudRateLimiter,
    session: &CloudSession,
    peer: &str,
    message: Option<&str>,
) -> ContactOutcome {
    let peer = peer.trim().to_string();
    if peer.is_empty() {
        return ContactOutcome::Failed(err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if peer == session.account_id {
        return ContactOutcome::Failed(err(
            "self_contact",
            "You cannot send a contact request to yourself.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(CONTACT_ADD_LIMIT, &session.account_id)
        .await
    {
        return ContactOutcome::Failed(limited_response(retry_after));
    }
    let message = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(280).collect::<String>());

    let pool = state.db_pool();

    // Peer must exist.
    let peer_account = match account_response_row(pool, &peer).await {
        Ok(Some(account)) => account,
        Ok(None) => {
            return ContactOutcome::Failed(err(
                "account_missing",
                "No account found with that id.",
                StatusCode::NOT_FOUND,
            ));
        }
        Err(_) => return database_error(),
    };

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
        Err(_) => return database_error(),
    };
    if already_contact.is_some() {
        return ContactOutcome::Failed(err(
            "already_contact",
            "You are already contacts.",
            StatusCode::CONFLICT,
        ));
    }

    // If they already asked us — auto-accept.
    let inbound_pending: Option<(String,)> = match query_as(
        "SELECT request_id FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&peer)
    .bind(&session.account_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => return database_error(),
    };
    if let Some((request_id,)) = inbound_pending {
        return finalize_request_acceptance(
            state,
            session,
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
        Err(_) => return database_error(),
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
        return ContactOutcome::Done(
            StatusCode::OK,
            Box::new(ContactRequestResponse {
                request: summary,
                hello_message: None,
            }),
        );
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
        return ContactOutcome::Failed(err(
            "server_error",
            "Could not record request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
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
    ContactOutcome::Done(
        StatusCode::CREATED,
        Box::new(ContactRequestResponse {
            request: summary,
            hello_message: None,
        }),
    )
}
