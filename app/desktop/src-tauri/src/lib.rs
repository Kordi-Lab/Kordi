mod auth;
mod bridge;
mod chat;
mod project;
mod workspace;

use tauri::Manager;
use auth::DesktopAuthManager;
use bridge::DesktopBridgeManager;
use chat::DesktopChatManager;
use workspace::DesktopWorkspaceStatus;

#[tauri::command]
fn desktop_workspace_status() -> DesktopWorkspaceStatus {
    workspace::desktop_workspace_status()
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopAuthManager::default())
        .manage(DesktopBridgeManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window should exist");
            window.set_title("Kordi")?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_workspace_status,
            project::desktop_project_settings,
            project::desktop_save_project_settings,
            bridge::desktop_bridge_state,
            bridge::desktop_save_bridge_host,
            bridge::desktop_remove_bridge_host,
            bridge::desktop_set_active_bridge_host,
            bridge::desktop_bridge_start_local_server,
            bridge::desktop_bridge_stop_local_server,
            bridge::desktop_bridge_create_project,
            bridge::desktop_bridge_create_invite,
            bridge::desktop_bridge_join_project,
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
