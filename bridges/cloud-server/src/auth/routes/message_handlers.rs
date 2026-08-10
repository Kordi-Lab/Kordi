use super::*;

/// `POST /v1/cloud/messages` — send a 1:1 message to a peer the caller
/// already has in their contacts. Body is plain UTF-8 for now; E2EE
/// is a later session (it'll migrate writes to `server_messages`).
pub(super) async fn send_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<SendMessageRequest>,
) -> Response {
    let peer = req.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let is_self_message = peer == session.account_id;
    let body = req.body.trim();
    if body.is_empty() && req.attachments.is_empty() {
        return err(
            "empty_message",
            "Message body or attachment is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let body = match normalize_cloud_message_body(body) {
        Ok(body) => body,
        Err("invalid_group_control") => {
            return err(
                "invalid_group_control",
                "Cloud group control payload is invalid.",
                StatusCode::BAD_REQUEST,
            );
        }
        Err("message_too_large") => {
            return err(
                "message_too_large",
                "Cloud control payload is too large.",
                StatusCode::BAD_REQUEST,
            );
        }
        Err(_) => {
            return err(
                "invalid_message",
                "Cloud message payload is invalid.",
                StatusCode::BAD_REQUEST,
            );
        }
    };

    let pool = state.db_pool();
    let support_prompt = state.support().and_then(|service| {
        crate::support::message_targets_support_agent(&body, &peer, service.config())
    });

    let mut attachments = Vec::new();
    for input in &req.attachments {
        let attachment_id = input.attachment_id.trim();
        if attachment_id.is_empty() {
            return err(
                "invalid_attachment",
                "attachmentId is required.",
                StatusCode::BAD_REQUEST,
            );
        }
        let row: Option<AttachmentOwnerRow> = match query_as(
            "SELECT owner_account_id, object_key, content_type, size_bytes, finalized_at \
             FROM cloud_attachments \
             WHERE attachment_id = $1",
        )
        .bind(attachment_id)
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
        let Some((owner_account_id, _object_key, db_mime_type, db_size_bytes, finalized_at)) = row
        else {
            return err(
                "invalid_attachment",
                "Attachment not found.",
                StatusCode::BAD_REQUEST,
            );
        };
        if owner_account_id != session.account_id {
            return err(
                "invalid_attachment",
                "Attachment does not belong to the sender.",
                StatusCode::FORBIDDEN,
            );
        }
        if finalized_at.is_none() {
            return err(
                "invalid_attachment",
                "Attachment upload has not been finalized.",
                StatusCode::CONFLICT,
            );
        }
        let normalized = match normalize_message_attachment(
            input,
            attachment_id,
            db_mime_type,
            db_size_bytes,
            None,
        ) {
            Ok(value) => value,
            Err(resp) => return *resp,
        };
        attachments.push(normalized);
    }

    // Both directions of the contact must exist. The peer must have
    // accepted you OR you must have accepted them — we enforce mutual
    // acceptance so an attacker who guesses an account id can't DM a
    // stranger. (Single-row check is fine because finalize_request_acceptance
    // always inserts both rows in the same tx.)
    let mutual: Option<(i32,)> = match query_as(
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
    if !is_self_message
        && mutual.is_none()
        && support_prompt.is_none()
        && cloud_message_requires_accepted_contact(&body)
    {
        return err(
            "not_a_contact",
            "You can only message accepted contacts.",
            StatusCode::FORBIDDEN,
        );
    }

    let supplied_client_message_id = req
        .client_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if supplied_client_message_id.is_some_and(|value| value.chars().count() > 512) {
        return err(
            "invalid_message",
            "clientMessageId is too long.",
            StatusCode::BAD_REQUEST,
        );
    }
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let cloud_session_id =
        cloud_message_session_id(req.session_id.as_deref(), &session.account_id, &peer, &body);
    let server_received_at = Utc::now();
    let valid_client_created_at =
        cloud_message_valid_client_created_at(req.client_created_at.as_deref(), server_received_at);
    let created_at = valid_client_created_at
        .clone()
        .unwrap_or_else(|| server_received_at.to_rfc3339());
    let legacy_client_message_id =
        (supplied_client_message_id.is_none() && is_self_message && attachments.is_empty())
            .then(|| {
                valid_client_created_at.as_deref().map(|client_created_at| {
                    legacy_self_message_client_id(
                        &session.account_id,
                        cloud_session_id.as_deref(),
                        &body,
                        client_created_at,
                    )
                })
            })
            .flatten();
    let legacy_replay_lock_id = legacy_client_message_id.as_ref().map(|_| {
        legacy_self_message_lock_id(&session.account_id, cloud_session_id.as_deref(), &body)
    });
    let client_message_id = supplied_client_message_id.or(legacy_client_message_id.as_deref());
    let delivered_at = server_received_at.to_rfc3339();
    let read_at = if is_self_message {
        Some(delivered_at.clone())
    } else {
        None
    };
    let persisted_attachments = attachments
        .iter()
        .map(|attachment| PersistedMessageAttachment {
            attachment_id: attachment.attachment_id.clone(),
            name: attachment.name.clone(),
            kind: attachment.kind.clone(),
            mime_type: attachment.mime_type.clone(),
            size_bytes: attachment.size_bytes,
            download_url: None,
            preview_url: attachment.preview_url.clone(),
        })
        .collect::<Vec<_>>();
    let outcome = match persist_cloud_message(
        pool,
        PersistCloudMessageInput {
            message_id: &message_id,
            from_account_id: &session.account_id,
            to_account_id: &peer,
            client_message_id,
            body: &body,
            session_id: cloud_session_id.as_deref(),
            created_at: &created_at,
            delivered_at: &delivered_at,
            read_at: read_at.as_deref(),
            attachments: &persisted_attachments,
            claim_legacy_self_replay: legacy_client_message_id.is_some(),
            legacy_self_replay_lock_id: legacy_replay_lock_id.as_deref(),
        },
    )
    .await
    {
        Ok(value) => value,
        Err(PersistCloudMessageError::IdempotencyConflict) => {
            return err(
                "idempotency_conflict",
                "clientMessageId was already used for a different message.",
                StatusCode::CONFLICT,
            );
        }
        Err(PersistCloudMessageError::Database(error)) => {
            eprintln!("[cloud-messages] transactional write failed: {error}");
            return err(
                "server_error",
                "Could not record message.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let summary = MessageSummary {
        message_id: outcome.message.message_id,
        from_account_id: outcome.message.from_account_id,
        to_account_id: outcome.message.to_account_id,
        body: outcome.message.body,
        session_id: outcome.message.session_id,
        created_at: outcome.message.created_at,
        delivered_at: outcome.message.delivered_at,
        read_at: outcome.message.read_at,
        direction: "outgoing".into(),
        attachments: outcome
            .message
            .attachments
            .into_iter()
            .map(|attachment| MessageAttachmentSummary {
                attachment_id: attachment.attachment_id,
                name: attachment.name,
                kind: attachment.kind,
                mime_type: attachment.mime_type,
                size_bytes: attachment.size_bytes,
                download_url: attachment.download_url,
                preview_url: attachment.preview_url,
            })
            .collect(),
    };

    // Publish only after the message, attachment links, visibility changes,
    // and durable sync events commit together. Duplicate retries already have
    // a published row and must not emit a second live delivery.
    if outcome.inserted {
        let events = state.events().clone();
        let message_id = summary.message_id.clone();
        let from = session.account_id.clone();
        let to = peer.clone();
        let body_clone = summary.body.clone();
        let created_at = summary.created_at.clone();
        let session_id = summary.session_id.clone();
        let event_attachments =
            serde_json::to_value(&summary.attachments).unwrap_or_else(|_| serde_json::json!([]));
        tokio::spawn(async move {
            events
                .publish_message_arrived(crate::events::MessageArrived {
                    message_id: &message_id,
                    from_account_id: &from,
                    to_account_id: &to,
                    body: &body_clone,
                    created_at: &created_at,
                    session_id: session_id.as_deref(),
                    attachments: event_attachments,
                })
                .await;
        });

        if let (Some(prompt), Some(service), Some(session_id)) = (
            support_prompt,
            state.support().cloned(),
            summary.session_id.clone(),
        ) {
            let pool = state.db_pool().clone();
            let input = ClaimRunRequest {
                request_message_id: summary.message_id.clone(),
                session_id,
                owner_account_id: service.config().owner_account_id.clone(),
                requester_account_id: session.account_id.clone(),
                prompt,
                idempotency_key: format!("kordi-support:{}", summary.message_id),
            };
            tokio::spawn(async move {
                if let Err(error) = claim_run(&pool, &input).await {
                    eprintln!(
                        "[support] queue hosted response for {}: {error}",
                        input.request_message_id
                    );
                }
            });
        }
    }

    (
        StatusCode::CREATED,
        Json(MessageResponse { message: summary }),
    )
        .into_response()
}
