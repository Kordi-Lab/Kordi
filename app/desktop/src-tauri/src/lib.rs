mod auth;
#[path = "bridge/mod.rs"]
mod bridge;
mod chat;
mod project;
mod workspace;

use std::process::Command;

use auth::DesktopAuthManager;
use bridge::DesktopBridgeManager;
use chat::DesktopChatManager;
use tauri::Manager;
use workspace::DesktopWorkspaceStatus;

#[tauri::command]
fn desktop_workspace_status() -> DesktopWorkspaceStatus {
    workspace::desktop_workspace_status()
}

fn run_external_command(command: &mut Command) -> Result<(), String> {
    let status = command.status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("External open command failed with status {status}"))
    }
}

#[tauri::command]
fn desktop_open_external_url(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }

    if cfg!(target_os = "macos") {
        run_external_command(Command::new("open").arg(trimmed))?;
    } else if cfg!(target_os = "windows") {
        run_external_command(Command::new("explorer").arg(trimmed))?;
    } else {
        run_external_command(Command::new("xdg-open").arg(trimmed))?;
    }

    Ok(trimmed.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopAuthManager::default())
        .manage(DesktopBridgeManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.set_title("Kordi")?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_workspace_status,
            desktop_open_external_url,
            project::desktop_project_settings,
            project::desktop_save_project_settings,
            bridge::desktop_bridge_state,
            bridge::desktop_bridge_open_config_folder,
            bridge::desktop_bridge_reveal_storage_file,
            bridge::desktop_bridge_export_hosts_config,
            bridge::desktop_bridge_import_hosts_config,
            bridge::desktop_save_bridge_host,
            bridge::desktop_remove_bridge_host,
            bridge::desktop_set_active_bridge_host,
            bridge::desktop_bridge_set_discovery_mode,
            bridge::desktop_bridge_create_agent,
            bridge::desktop_bridge_activate_agent,
            bridge::desktop_bridge_rename_agent,
            bridge::desktop_bridge_set_default_agent,
            bridge::desktop_bridge_start_local_server,
            bridge::desktop_bridge_stop_local_server,
            bridge::desktop_bridge_create_project,
            bridge::desktop_bridge_create_invite,
            bridge::desktop_bridge_join_project,
            bridge::desktop_bridge_add_contact,
            bridge::desktop_bridge_remove_contact,
            bridge::desktop_bridge_open_conversation,
            bridge::desktop_bridge_mark_conversation_read,
            bridge::desktop_bridge_send_message,
            bridge::desktop_bridge_send_presence,
            bridge::desktop_bridge_poll_mailbox,
            auth::desktop_auth_state,
            auth::desktop_save_api_key,
            auth::desktop_logout,
            auth::desktop_remove_auth_profile,
            auth::desktop_set_active_auth_profile,
            auth::desktop_set_active_auth_choice,
            auth::desktop_start_oauth_login,
            auth::desktop_auth_attempt_state,
            auth::desktop_submit_auth_manual_input,
            auth::desktop_cancel_auth_attempt,
            chat::desktop_chat_store_attachment,
            chat::desktop_chat_artifact_preview,
            chat::desktop_chat_state,
            chat::desktop_chat_new_session,
            chat::desktop_chat_update_session_config,
            chat::desktop_chat_rename_session,
            chat::desktop_chat_send_message,
            chat::desktop_chat_start_message,
            chat::desktop_chat_run_skill_command,
            chat::desktop_chat_cancel_turn,
            chat::desktop_chat_turn_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kordi desktop");
}
