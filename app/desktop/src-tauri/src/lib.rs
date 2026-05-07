mod auth;
#[path = "bridge/mod.rs"]
mod bridge;
mod canonical_sessions;
mod chat;
mod project;
#[cfg(test)]
mod test_support;
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

#[tauri::command]
fn desktop_read_workspace_text_file(path: String) -> Result<String, String> {
    workspace::desktop_read_workspace_text_file(path)
}

#[tauri::command]
fn desktop_write_workspace_text_file(path: String, contents: String) -> Result<String, String> {
    workspace::desktop_write_workspace_text_file(path, contents)
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
    let app = tauri::Builder::default()
        .manage(DesktopAuthManager::default())
        .manage(DesktopBridgeManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.set_title("Kordi")?;
            if let Err(err) = chat::allow_attachment_asset_scope(app) {
                eprintln!("[kordi] Unable to allow attachment preview assets: {err}");
            }
            let bridge_manager = app.state::<DesktopBridgeManager>();
            tauri::async_runtime::block_on(bridge::set_bridge_app_handle(
                &bridge_manager,
                app.handle().clone(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_workspace_status,
            desktop_read_workspace_text_file,
            desktop_write_workspace_text_file,
            desktop_open_external_url,
            project::desktop_project_settings,
            project::desktop_project_create_from_folder,
            project::desktop_project_create_new,
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
            bridge::desktop_bridge_set_host_privacy_policy,
            bridge::desktop_bridge_set_agent_reachability_policy,
            bridge::desktop_bridge_create_agent,
            bridge::desktop_bridge_activate_agent,
            bridge::desktop_bridge_rename_agent,
            bridge::desktop_bridge_update_agent_model_routing,
            bridge::desktop_bridge_update_local_agent_model_routing,
            bridge::desktop_bridge_set_default_agent,
            bridge::desktop_bridge_start_local_server,
            bridge::desktop_bridge_stop_local_server,
            bridge::desktop_bridge_create_project,
            bridge::desktop_bridge_create_invite,
            bridge::desktop_bridge_join_project,
            bridge::desktop_bridge_add_contact,
            bridge::desktop_bridge_remove_contact,
            bridge::desktop_bridge_approve_contact_request,
            bridge::desktop_bridge_reject_contact_request,
            bridge::desktop_bridge_open_conversation,
            bridge::desktop_bridge_mark_conversation_read,
            bridge::desktop_bridge_send_message,
            bridge::desktop_bridge_create_outreach,
            bridge::desktop_bridge_cancel_outreach,
            bridge::desktop_bridge_send_presence,
            bridge::desktop_bridge_poll_mailbox,
            bridge::desktop_bridge_refresh_realtime_connections,
            canonical_sessions::desktop_canonical_session_state,
            canonical_sessions::desktop_canonical_upsert_identity,
            canonical_sessions::desktop_canonical_open_or_create_session,
            canonical_sessions::desktop_canonical_append_message,
            canonical_sessions::desktop_canonical_append_message_fast,
            canonical_sessions::desktop_canonical_create_delegated_exchange,
            canonical_sessions::desktop_canonical_update_presence,
            canonical_sessions::desktop_canonical_rename_session,
            canonical_sessions::desktop_canonical_update_session_metadata,
            canonical_sessions::desktop_canonical_add_session_participants,
            canonical_sessions::desktop_canonical_remove_session_participant,
            canonical_sessions::desktop_canonical_set_session_participant_role,
            auth::desktop_auth_state,
            auth::desktop_save_api_key,
            auth::desktop_set_local_provider_port,
            auth::desktop_logout,
            auth::desktop_remove_auth_profile,
            auth::desktop_set_active_auth_profile,
            auth::desktop_set_active_auth_choice,
            auth::desktop_start_oauth_login,
            auth::desktop_auth_attempt_state,
            auth::desktop_submit_auth_manual_input,
            auth::desktop_cancel_auth_attempt,
            auth::lm_studio::desktop_lm_studio_catalog_models,
            auth::lm_studio::desktop_lm_studio_environment,
            auth::lm_studio::desktop_lm_studio_installed_models,
            auth::lm_studio::desktop_lm_studio_loaded_model_ids,
            auth::lm_studio::desktop_lm_studio_server_status,
            auth::lm_studio::desktop_lm_studio_start_server,
            auth::lm_studio::desktop_lm_studio_stop_server,
            auth::lm_studio::desktop_lm_studio_open_app,
            auth::lm_studio::desktop_lm_studio_repair_cli_path,
            auth::lm_studio::desktop_lm_studio_install,
            auth::lm_studio::desktop_lm_studio_get_model,
            auth::lm_studio::desktop_lm_studio_load_model,
            auth::lm_studio::desktop_lm_studio_stop_model,
            auth::ollama::desktop_ollama_environment,
            auth::ollama::desktop_ollama_server_status,
            auth::ollama::desktop_ollama_start_server,
            auth::ollama::desktop_ollama_open_app,
            auth::ollama::desktop_ollama_install,
            auth::ollama::desktop_ollama_catalog_models,
            auth::ollama::desktop_ollama_catalog_variants,
            auth::ollama::desktop_ollama_installed_models,
            auth::ollama::desktop_ollama_running_model_ids,
            auth::ollama::desktop_ollama_pull_model,
            auth::ollama::desktop_ollama_load_model,
            auth::ollama::desktop_ollama_stop_model,
            auth::ollama::desktop_ollama_delete_model,
            chat::attachments::desktop_chat_store_attachment,
            chat::attachments::desktop_chat_store_attachment_path,
            chat::attachments::desktop_chat_download_attachment,
            chat::artifacts::desktop_chat_artifact_preview,
            chat::artifacts::desktop_chat_artifact_directory,
            chat::desktop_chat_state,
            chat::desktop_chat_new_session,
            chat::desktop_chat_new_project_session,
            chat::desktop_chat_prepare_draft_session,
            chat::desktop_chat_update_session_config,
            chat::desktop_chat_rename_session,
            chat::desktop_chat_archive_session,
            chat::desktop_chat_delete_session_forever,
            chat::desktop_chat_move_session_to_project,
            chat::desktop_chat_send_message,
            chat::desktop_chat_start_message,
            chat::desktop_chat_run_skill_command,
            chat::desktop_chat_cancel_turn,
            chat::desktop_chat_turn_state
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kordi desktop");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::Resumed => {
            bridge::schedule_bridge_realtime_refresh(app_handle, "app-resumed");
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Focused(true),
            ..
        } => {
            bridge::schedule_bridge_realtime_refresh(app_handle, "window-focused");
        }
        _ => {}
    });
}
