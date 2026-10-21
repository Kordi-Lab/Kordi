//! `GET /v1/cloud/contacts/:account_id/profile` (#1945): one contact's
//! profile with presence, what the two accounts share, and their Common
//! ground card when the viewer may see it.
//!
//! Visible: yourself, an accepted contact, the system contact, and the
//! default agent (`cloud-agent:<owner>`) of yourself or a contact. Anything
//! else is a 404, so the route never confirms that an account exists.

use super::*;

mod queries;
#[cfg(test)]
mod tests;
mod types;

use types::*;

/// Advertised as `contactProfileVersion` in the auth capabilities.
pub(crate) const CONTACT_PROFILE_VERSION: u32 = 1;
/// Topics per Common ground list on a profile.
const COMMON_GROUND_TOPICS: usize = 4;

pub(super) async fn get_contact_profile(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    match contact_profile(&state, &session.account_id, account_id.trim()).await {
        Ok(Some(profile)) => Json(profile).into_response(),
        Ok(None) => err(
            "contact_not_found",
            "This contact isn't available.",
            StatusCode::NOT_FOUND,
        ),
        Err(error) => {
            eprintln!("[contacts] contact profile: {error}");
            err(
                "server_error",
                "Could not load the contact profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

async fn contact_profile(
    state: &ServerState,
    viewer: &str,
    target: &str,
) -> Result<Option<ContactProfileResponse>, sqlx_core::Error> {
    if target.is_empty() {
        return Ok(None);
    }
    if let Some(support) = state.support() {
        let config = support.config();
        if target == config.owner_account_id && target != viewer {
            return Ok(Some(system_profile(target, config)));
        }
    }
    if let Some(owner) = target.strip_prefix("cloud-agent:") {
        return agent_profile(state, viewer, target, owner).await;
    }
    person_profile(state, viewer, target).await
}

fn system_profile(target: &str, config: &crate::support::SupportConfig) -> ContactProfileResponse {
    ContactProfileResponse {
        account_id: target.to_string(),
        kordi_id: None,
        display_name: Some(config.name.clone()),
        avatar_url: None,
        about: None,
        kind: "system",
        is_self: false,
        is_contact: true,
        presence: None,
        default_agent: None,
        owner: None,
        contact_since: None,
        shared: SharedSummary::default(),
        common_ground: None,
    }
}

async fn person_profile(
    state: &ServerState,
    viewer: &str,
    target: &str,
) -> Result<Option<ContactProfileResponse>, sqlx_core::Error> {
    let pool = state.db_pool();
    let is_self = target == viewer;
    let contact_since = if is_self {
        None
    } else {
        match queries::contact_since(pool, viewer, target).await? {
            Some(created_at) => Some(created_at),
            None => return Ok(None),
        }
    };
    let Some(account) = queries::account(pool, target).await? else {
        return Ok(None);
    };
    let now = Utc::now();
    let agent_row = default_agent_profile_row(pool, target).await?;
    let agent = default_agent_profile_from_row(target, agent_row, &now.to_rfc3339());
    let presence = crate::presence::account_presence_status(
        pool,
        target,
        now,
        crate::presence::presence_timeout(),
    )
    .await?;
    let shared = if is_self {
        SharedSummary::default()
    } else {
        queries::shared(pool, viewer, target).await?
    };
    let common_ground =
        crate::common_ground::profile_common_ground(pool, viewer, target, COMMON_GROUND_TOPICS)
            .await?;
    Ok(Some(ContactProfileResponse {
        account_id: account.account_id,
        kordi_id: Some(account.kordi_id.to_string()),
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        about: account.about,
        kind: "person",
        is_self,
        is_contact: contact_since.is_some(),
        presence: Some(ProfilePresence {
            status: presence.status.as_str(),
            last_seen_at: presence.last_seen_at,
        }),
        default_agent: Some(ProfileDefaultAgent {
            account_id: agent.agent_id.clone(),
            agent,
        }),
        owner: None,
        contact_since,
        shared,
        common_ground,
    }))
}

async fn agent_profile(
    state: &ServerState,
    viewer: &str,
    target: &str,
    owner_id: &str,
) -> Result<Option<ContactProfileResponse>, sqlx_core::Error> {
    let pool = state.db_pool();
    // Only an account's own default agent id is addressable.
    if owner_id.is_empty() || default_agent_id(owner_id) != target {
        return Ok(None);
    }
    let owner_is_contact = owner_id != viewer
        && queries::contact_since(pool, viewer, owner_id)
            .await?
            .is_some();
    if owner_id != viewer && !owner_is_contact {
        return Ok(None);
    }
    let Some(owner) = queries::account(pool, owner_id).await? else {
        return Ok(None);
    };
    let agent_row = default_agent_profile_row(pool, owner_id).await?;
    let agent = default_agent_profile_from_row(owner_id, agent_row, &Utc::now().to_rfc3339());
    Ok(Some(ContactProfileResponse {
        account_id: agent.agent_id,
        kordi_id: None,
        display_name: Some(agent.display_name),
        avatar_url: agent.avatar_url,
        about: None,
        kind: "agent",
        is_self: false,
        is_contact: owner_is_contact,
        presence: None,
        default_agent: None,
        owner: Some(ProfileOwner {
            account_id: owner.account_id,
            kordi_id: owner.kordi_id.to_string(),
            display_name: owner.display_name,
            avatar_url: owner.avatar_url,
        }),
        contact_since: None,
        shared: SharedSummary::default(),
        common_ground: None,
    }))
}
