use super::constants::DEFAULT_LOCAL_SERVER_PORT;
use super::host_commands::desktop_save_bridge_host_impl;
use super::{
    build_current_bridge_state, start_local_server, stop_local_server, DesktopBridgeManager,
    DesktopBridgeState,
};

pub(super) async fn desktop_bridge_start_local_server_impl(
    manager: &DesktopBridgeManager,
    port: Option<u16>,
    display_name: Option<String>,
    owner_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let port = port.unwrap_or(DEFAULT_LOCAL_SERVER_PORT);
    let status = start_local_server(manager, port).await?;
    let server_url = status
        .server_url
        .clone()
        .ok_or_else(|| "Local bridge server URL is unavailable".to_string())?;

    desktop_save_bridge_host_impl(manager, None, server_url, display_name, owner_name).await
}

pub(super) async fn desktop_bridge_stop_local_server_impl(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeState, String> {
    let _ = stop_local_server(manager).await?;
    Ok(build_current_bridge_state(manager).await)
}
