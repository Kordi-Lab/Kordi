use super::constants::API_STYLE_SERVE;
use super::{
    build_current_bridge_state, create_serve_invite, create_serve_project,
    current_local_server_status, join_serve_project, load_bridge_store, DesktopBridgeHostConfig,
    DesktopBridgeInvite, DesktopBridgeManager, DesktopBridgeState, DesktopBridgeStore,
};

const SERVE_ONLY_CREATE_PROJECT_MESSAGE: &str =
    "Project creation is currently supported on self-hosted Bridges serve hosts only";
const SERVE_ONLY_INVITES_MESSAGE: &str =
    "Project invites are currently supported on self-hosted Bridges serve hosts only";
const SERVE_ONLY_JOINS_MESSAGE: &str =
    "Project joins are currently supported on self-hosted Bridges serve hosts only";

fn find_host(store: &DesktopBridgeStore, host_id: &str) -> Result<DesktopBridgeHostConfig, String> {
    store
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())
}

fn require_serve_host(
    store: &DesktopBridgeStore,
    host_id: &str,
    unsupported_message: &str,
) -> Result<DesktopBridgeHostConfig, String> {
    let host = find_host(store, host_id)?;
    if host.api_style != API_STYLE_SERVE {
        return Err(unsupported_message.to_string());
    }
    Ok(host)
}

pub(super) async fn desktop_bridge_create_project_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("Project slug cannot be empty".to_string());
    }

    let store = load_bridge_store();
    let host = require_serve_host(&store, &host_id, SERVE_ONLY_CREATE_PROJECT_MESSAGE)?;
    let _ = create_serve_project(
        &host.coordination,
        &host.api_key,
        slug,
        display_name.as_deref(),
        description.as_deref(),
    )
    .await?;
    Ok(build_current_bridge_state(manager).await)
}

pub(super) async fn desktop_bridge_create_invite_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    project_id: String,
    max_uses: Option<i64>,
) -> Result<DesktopBridgeInvite, String> {
    let store = load_bridge_store();
    let host = require_serve_host(&store, &host_id, SERVE_ONLY_INVITES_MESSAGE)?;
    let invite =
        create_serve_invite(&host.coordination, &host.api_key, &project_id, max_uses).await?;
    let share_text = format!(
        "Join my bridge project:\nHost: {}\nProject: {}\nInvite token: {}",
        host.coordination, invite.project_id, invite.invite_token
    );
    let _ = current_local_server_status(manager).await;
    Ok(DesktopBridgeInvite {
        host_id,
        project_id: invite.project_id,
        invite_id: invite.invite_id,
        invite_token: invite.invite_token,
        share_text,
    })
}

pub(super) async fn desktop_bridge_join_project_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    project_id: String,
    invite_token: String,
    agent_role: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();
    let host = require_serve_host(&store, &host_id, SERVE_ONLY_JOINS_MESSAGE)?;
    join_serve_project(
        &host.coordination,
        &host.api_key,
        &project_id,
        invite_token.trim(),
        agent_role.as_deref(),
    )
    .await?;
    Ok(build_current_bridge_state(manager).await)
}
