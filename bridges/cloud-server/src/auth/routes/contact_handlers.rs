use super::*;

/// `POST /v1/cloud/contacts` — the older one-sided add. It never writes
/// contact rows: it accepts the peer's pending request (204), reports an
/// existing relationship (204), or sends the caller's contact request (202).
pub(super) async fn add_contact(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Json(req): Json<AddContactRequest>,
) -> Response {
    match request_or_accept_contact(&state, &session, &rate_limiter, &req.peer_account_id, None)
        .await
    {
        Err(response) => *response,
        Ok(ContactRequestOutcome::AlreadyContacts | ContactRequestOutcome::Accepted(_)) => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(ContactRequestOutcome::Pending { summary, .. }) => (
            StatusCode::ACCEPTED,
            Json(ContactRequestPendingResponse {
                status: "requested",
                request: *summary,
            }),
        )
            .into_response(),
    }
}

pub(super) async fn list_contacts(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();

    let rows: Vec<ContactListRow> = match query_as(
        "SELECT a.account_id, a.public_account_number, a.display_name, a.avatar_url, c.created_at, \
                agent.owner_account_id, agent.display_name, agent.avatar_url, agent.avatar_source, \
                agent.avatar_style, agent.avatar_seed, agent.avatar_renderer_version, \
                agent.avatar_version, agent.avatar_updated_at \
         FROM cloud_contacts c \
         JOIN cloud_accounts a ON a.account_id = c.peer_account_id \
         JOIN cloud_default_agent_profiles agent ON agent.owner_account_id = a.account_id \
         WHERE c.account_id = $1 \
           AND cloud_accounts_are_contacts(c.account_id, c.peer_account_id) \
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
            let default_agent = default_agent_profile_from_row(
                &row.0,
                Some((
                    row.5, row.6, row.7, row.8, row.9, row.10, row.11, row.12, row.13,
                )),
                &row.4,
            );
            ContactSummary {
                contact_id: None,
                contact_kind: None,
                account_id: row.0,
                kordi_id: Some(row.1.to_string()),
                display_name: row.2,
                subtitle: None,
                avatar_url: row.3,
                default_agent: Some(default_agent),
                node_id: None,
                created_at: row.4,
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
