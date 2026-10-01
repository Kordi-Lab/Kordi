use super::*;

// ---------- Contact request flow ----------

/// `POST /v1/cloud/contacts/requests` — send a contact request.
///
/// If there's already an *incoming* pending request from the same peer
/// (i.e. they asked us first), this accepts it and makes the relationship
/// mutual (200). An existing outgoing request is returned unchanged (200);
/// otherwise a new pending request is recorded (201) and the recipient's
/// open WebSocket learns about it through NATS. See
/// [`request_or_accept_contact`] for the block and contact checks.
pub(super) async fn send_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(req): Json<SendContactRequestBody>,
) -> Response {
    let outcome = request_or_accept_contact(
        &state,
        &session,
        &rate_limiter,
        &req.peer_account_id,
        req.message.as_deref(),
    )
    .await;
    match outcome {
        Err(response) => *response,
        Ok(ContactRequestOutcome::AlreadyContacts) => err(
            "already_contact",
            "You are already contacts.",
            StatusCode::CONFLICT,
        ),
        Ok(ContactRequestOutcome::Accepted(accepted)) => {
            (StatusCode::OK, Json(*accepted)).into_response()
        }
        Ok(ContactRequestOutcome::Pending { summary, created }) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(ContactRequestResponse {
                request: *summary,
                hello_message: None,
            }),
        )
            .into_response(),
    }
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
        return request_decided();
    }

    match finalize_request_acceptance(&state, &session, pool, &request_id, &from_id, &to_id).await {
        Ok(accepted) => (StatusCode::OK, Json(accepted)).into_response(),
        Err(response) => *response,
    }
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
        return request_decided();
    }

    match decide_pending_request(pool, &request_id, &from_id, &to_id, "rejected").await {
        Ok(true) => {}
        Ok(false) => return request_decided(),
        Err(_) => {
            return err(
                "server_error",
                "Could not reject request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
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

pub(super) fn request_decided() -> Response {
    err(
        "request_decided",
        "This request was already answered or withdrawn.",
        StatusCode::CONFLICT,
    )
}

/// Moves a pending request to `status` (`rejected` or `withdrawn`) under the
/// pair lock. Returns false when it was no longer pending, so exactly one of
/// accept, reject, withdraw, or block decides a request.
pub(super) async fn decide_pending_request(
    pool: &PgPool,
    request_id: &str,
    from_id: &str,
    to_id: &str,
    status: &'static str,
) -> Result<bool, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    crate::relationships::lock_pair(&mut tx, from_id, to_id).await?;
    let updated = query(
        "UPDATE cloud_contact_requests SET status = $1, decided_at = $2 \
         WHERE request_id = $3 AND status = 'pending'",
    )
    .bind(status)
    .bind(Utc::now().to_rfc3339())
    .bind(request_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated != 1 {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}
