use super::*;

pub(super) async fn add_contact(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(req): Json<AddContactRequest>,
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
            "You cannot add yourself as a contact.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(CONTACT_ADD_LIMIT, &session.account_id)
        .await
    {
        return limited_response(retry_after);
    }

    let pool = state.db_pool();

    let peer_exists: Option<(i32,)> =
        match query_as("SELECT 1 FROM cloud_accounts WHERE account_id = $1")
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
    if peer_exists.is_none() {
        return err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        );
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3) \
         ON CONFLICT (account_id, peer_account_id) DO NOTHING",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not add contact.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.added",
        serde_json::json!({"peer": peer}),
    )
    .await;

    // Notify the peer's open WebSocket(s). Fire-and-forget for the same
    // reasons as signup: the HTTP caller shouldn't pay NATS latency or
    // fail the request if the bus blips.
    {
        let events = state.events().clone();
        let actor = session.account_id.clone();
        let peer = peer.clone();
        tokio::spawn(async move {
            events.publish_contact_added(&actor, &peer).await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn list_contacts(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();

    let rows: Vec<ContactListRow> = match query_as(
        "SELECT a.account_id, COALESCE(a.public_handle, a.public_account_number::TEXT) AS kordi_id, \
                a.display_name, a.avatar_url, c.created_at, a.about, a.location, a.time_zone, a.website, \
                agent.owner_account_id AS agent_owner_account_id, agent.display_name AS agent_display_name, \
                agent.avatar_url AS agent_avatar_url, agent.avatar_source AS agent_avatar_source, \
                agent.avatar_style AS agent_avatar_style, agent.avatar_seed AS agent_avatar_seed, \
                agent.avatar_renderer_version AS agent_avatar_renderer_version, \
                agent.avatar_version AS agent_avatar_version, \
                agent.avatar_updated_at AS agent_avatar_updated_at \
         FROM cloud_contacts c \
         JOIN cloud_accounts a ON a.account_id = c.peer_account_id \
         JOIN cloud_default_agent_profiles agent ON agent.owner_account_id = a.account_id \
         WHERE c.account_id = $1 \
         ORDER BY c.created_at ASC",
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

    let mut contacts = rows
        .into_iter()
        .map(|row| {
            let default_agent =
                default_agent_profile_from_row(&row.account_id, Some(row.agent), &row.created_at);
            ContactSummary {
                contact_id: None,
                contact_kind: None,
                account_id: row.account_id,
                kordi_id: Some(row.kordi_id),
                display_name: row.display_name,
                subtitle: None,
                about: row.about,
                location: row.location,
                time_zone: row.time_zone,
                website: row.website,
                avatar_url: row.avatar_url,
                default_agent: Some(default_agent),
                node_id: None,
                created_at: row.created_at,
                locked: false,
                target_cloud_agent_id: None,
                target_cloud_agent_name: None,
                target_cloud_agent_owner_account_id: None,
                target_cloud_agent_owner_name: None,
                support_ticket_enabled: false,
            }
        })
        .collect::<Vec<_>>();

    if let Some(service) = state.support() {
        contacts.insert(0, crate::support::support_contact(service.config()));
    }

    Json(ContactsListResponse { contacts }).into_response()
}
