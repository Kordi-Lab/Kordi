use super::*;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::chat_sync::store;

const CONTACT_ACCEPTANCE_GREETING: &str = "👋 Hi! Thanks for adding me — happy to connect.";

fn stable_contact_acceptance_uuid(scope: &str, value: &str) -> Uuid {
    let digest = Sha256::digest(format!("{scope}\0{}", value.trim()));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn direct_person_session_id(left_account_id: &str, right_account_id: &str) -> String {
    let mut account_ids = [left_account_id.trim(), right_account_id.trim()];
    account_ids.sort_unstable();
    format!(
        "session:direct-person:{}:{}",
        account_ids[0], account_ids[1]
    )
}

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

    // Preserve the established acceptance behavior on the canonical V2 chat
    // timeline. Conversation creation, greeting insertion, and contact rows
    // share this transaction so clients never observe a permanently empty
    // contact caused by a partial acceptance.
    let hello_session_id = direct_person_session_id(from_id, to_id);
    let hello_conversation = match store::create_conversation_in_transaction(
        &mut tx,
        to_id,
        CreateConversationRequest {
            client_operation_id: stable_contact_acceptance_uuid(
                "contact-acceptance-conversation",
                &hello_session_id,
            ),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: hello_session_id.clone(),
            member_account_ids: vec![from_id.to_string()],
        },
        None,
    )
    .await
    {
        Ok(outcome) => outcome.value,
        Err(_) => {
            return err(
                "server_error",
                "Could not open the contact conversation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let hello_message = match store::send_message_in_transaction(
        &mut tx,
        to_id,
        hello_conversation.id,
        SendMessageRequest {
            client_message_id: stable_contact_acceptance_uuid(
                "contact-acceptance-greeting",
                request_id,
            ),
            kind: "text".to_string(),
            content: serde_json::json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": CONTACT_ACCEPTANCE_GREETING }],
                "legacy_attachments": [],
            }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    {
        Ok(outcome) => outcome.value,
        Err(_) => {
            return err(
                "server_error",
                "Could not record the contact greeting.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

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

    {
        let events = state.events().clone();
        let request_id = request_id.to_string();
        let from = from_id.to_string();
        let to = to_id.to_string();
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
    let hello_created_at = hello_message.created_at.to_rfc3339();
    let hello_summary = MessageSummary {
        message_id: hello_message.id.to_string(),
        from_account_id: to_id.to_string(),
        to_account_id: from_id.to_string(),
        body: CONTACT_ACCEPTANCE_GREETING.to_string(),
        session_id: Some(hello_session_id),
        created_at: hello_created_at.clone(),
        delivered_at: (session.account_id == from_id).then_some(hello_created_at),
        read_at: None,
        direction: if session.account_id == to_id {
            "outgoing".to_string()
        } else {
            "incoming".to_string()
        },
        attachments: Vec::new(),
    };
    (
        StatusCode::OK,
        Json(ContactRequestResponse {
            request: summary,
            hello_message: Some(hello_summary),
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
