mod auth;
#[path = "bridge/mod.rs"]
mod bridge;
mod canonical_sessions;
mod chat;
mod cloud_account_paths;
mod cloud_oauth_loopback;
mod cloud_session;
mod project;
#[cfg(test)]
mod test_support;
mod workspace;

use std::process::Command;
use std::time::Duration;

use serde::Serialize;

fn is_cloud_edition_context(
    kordi_edition: Option<&str>,
    vite_kordi_edition: Option<&str>,
    bundle_identifier: &str,
) -> bool {
    let explicit = kordi_edition
        .or(vite_kordi_edition)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match explicit.as_str() {
        "cloud" => true,
        "local" => false,
        _ => bundle_identifier == "io.kordi.cloud",
    }
}

fn is_cloud_edition_app(app: &tauri::App) -> bool {
    is_cloud_edition_context(
        std::env::var("KORDI_EDITION").ok().as_deref(),
        std::env::var("VITE_KORDI_EDITION").ok().as_deref(),
        &app.config().identifier,
    )
}

fn configure_cloud_app_data_dir(app: &tauri::App, is_cloud_edition: bool) {
    if !is_cloud_edition || std::env::var_os("APP_DATA_DIR").is_some() {
        return;
    }
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    // Cloud Edition must not read/write the local/localhost Kordi stores under
    // ~/.korde. The Cloud bundle uses a separate identifier, so Tauri's app
    // data dir is isolated from the local build and from old Bridge state.
    unsafe { std::env::set_var("APP_DATA_DIR", app_data_dir) };
}

fn activate_stored_cloud_account_data_dir(is_cloud_edition: bool) {
    if !is_cloud_edition {
        return;
    }
    match cloud_session::cloud_session_load() {
        Ok(Some(session)) => {
            if let Err(err) =
                cloud_account_paths::cloud_account_storage_activate(session.account_id)
            {
                eprintln!("[kordi] Unable to activate Cloud account storage: {err}");
            }
        }
        Ok(None) => {}
        Err(err) => eprintln!("[kordi] Unable to load Cloud session during storage setup: {err}"),
    }
}

use auth::DesktopAuthManager;
use bridge::DesktopBridgeManager;
use chat::DesktopChatManager;
use tauri::Manager;
use workspace::DesktopWorkspaceStatus;

const MAIN_WINDOW_LABEL: &str = "main";

fn should_hide_window_instead_of_close(label: &str) -> bool {
    cfg!(target_os = "macos") && label == MAIN_WINDOW_LABEL
}

fn should_show_main_window_on_reopen(has_visible_windows: bool) -> bool {
    cfg!(target_os = "macos") && !has_visible_windows
}

fn should_publish_presence_offline_on_exit() -> bool {
    true
}

const DEFAULT_CLOUD_API_BASE_URL: &str = "https://coordinar.io";
const DEFAULT_RELEASE_VERSION_URL: &str = "https://coordinar.io/updates/releases/version";
const DEFAULT_RELEASE_CHANGELOG_URL: &str = "https://github.com/Kordi-AI/Kordi/releases";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_millis(1500);

fn cloud_api_base_url_from_env() -> String {
    std::env::var("VITE_KORDI_CLOUD_API_BASE")
        .or_else(|_| std::env::var("KORDI_CLOUD_API_BASE"))
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLOUD_API_BASE_URL.to_string())
}

fn cloud_presence_offline_url(base_url: &str) -> String {
    format!(
        "{}/v1/cloud/presence/offline",
        base_url.trim().trim_end_matches('/')
    )
}

fn publish_cloud_presence_offline(token: &str, base_url: &str) -> Result<(), String> {
    let url = cloud_presence_offline_url(base_url);
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|err| err.to_string())?
        .post(url)
        .bearer_auth(token)
        .send()
        .map_err(|err| err.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("presence_offline_failed: {}", response.status()))
    }
}

fn release_version_url_from_env() -> String {
    std::env::var("KORDI_UPDATE_CHECK_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASE_VERSION_URL.to_string())
}

fn update_install_command_from_env() -> String {
    std::env::var("KORDI_UPDATE_CHECK_INSTALL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            format!("Download the latest Kordi release from {DEFAULT_RELEASE_CHANGELOG_URL}")
        })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateCheckResult {
    status: String,
    current_version: String,
    latest_version: Option<String>,
    changelog_url: Option<String>,
    install_command: Option<String>,
    message: String,
}

fn update_response_text_field(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(name)?.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_update_latest_version_response(
    body: &str,
) -> Result<(String, Option<String>, Option<String>), String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Update endpoint returned an empty response".to_string());
    }
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(version) =
            update_response_text_field(&json, &["version", "latestVersion", "latest_version"])
        {
            let changelog_url = update_response_text_field(
                &json,
                &["changelogUrl", "changelog_url", "releaseNotesUrl"],
            );
            let install_command =
                update_response_text_field(&json, &["installCommand", "install_command"]);
            return Ok((version, changelog_url, install_command));
        }
    }
    let version = trimmed.trim_matches('"').trim().to_string();
    if version.is_empty() {
        Err("Update endpoint did not include a version".to_string())
    } else {
        Ok((version, None, None))
    }
}

fn check_for_updates_blocking() -> Result<DesktopUpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let url = release_version_url_from_env();
    let response = reqwest::blocking::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .map_err(|err| err.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(DesktopUpdateCheckResult {
            status: "unavailable".to_string(),
            current_version,
            latest_version: None,
            changelog_url: Some(DEFAULT_RELEASE_CHANGELOG_URL.to_string()),
            install_command: None,
            message: "No Kordi release metadata is available yet.".to_string(),
        });
    }
    let body = response
        .error_for_status()
        .map_err(|err| err.to_string())?
        .text()
        .map_err(|err| err.to_string())?;
    let (latest_version, changelog_url, install_command) =
        parse_update_latest_version_response(&body)?;
    if latest_version == current_version {
        return Ok(DesktopUpdateCheckResult {
            status: "upToDate".to_string(),
            current_version,
            latest_version: Some(latest_version.clone()),
            changelog_url: changelog_url
                .or_else(|| Some(DEFAULT_RELEASE_CHANGELOG_URL.to_string())),
            install_command: None,
            message: format!("Kordi {latest_version} is up to date."),
        });
    }
    Ok(DesktopUpdateCheckResult {
        status: "updateAvailable".to_string(),
        current_version,
        latest_version: Some(latest_version.clone()),
        changelog_url: changelog_url.or_else(|| Some(DEFAULT_RELEASE_CHANGELOG_URL.to_string())),
        install_command: install_command.or_else(|| Some(update_install_command_from_env())),
        message: format!("Kordi {latest_version} is available."),
    })
}

#[tauri::command]
async fn desktop_check_for_updates() -> Result<DesktopUpdateCheckResult, String> {
    tauri::async_runtime::spawn_blocking(check_for_updates_blocking)
        .await
        .map_err(|err| err.to_string())?
}

fn publish_stored_cloud_presence_offline_on_exit() {
    if !should_publish_presence_offline_on_exit() {
        return;
    }
    let session = match cloud_session::cloud_session_load() {
        Ok(Some(session)) => session,
        Ok(None) => return,
        Err(err) => {
            eprintln!("[kordi] Unable to load Cloud session for presence offline: {err}");
            return;
        }
    };
    let base_url = cloud_api_base_url_from_env();
    let token = session.token;
    if let Err(err) = publish_cloud_presence_offline(&token, &base_url) {
        eprintln!("[kordi] Unable to publish Cloud presence offline on quit: {err}");
    }
}

#[cfg(test)]
mod window_lifecycle_tests {
    use super::{
        cloud_presence_offline_url, is_cloud_edition_context, should_hide_window_instead_of_close,
        should_publish_presence_offline_on_exit, should_show_main_window_on_reopen,
        DEFAULT_CLOUD_API_BASE_URL,
    };

    #[test]
    fn macos_main_window_close_hides_instead_of_quitting() {
        assert!(should_hide_window_instead_of_close("main"));
        assert!(!should_hide_window_instead_of_close("secondary"));
    }

    #[test]
    fn dock_reopen_restores_main_window_when_none_are_visible() {
        assert!(should_show_main_window_on_reopen(false));
        assert!(!should_show_main_window_on_reopen(true));
    }

    #[test]
    fn explicit_app_exit_publishes_presence_offline() {
        assert!(should_publish_presence_offline_on_exit());
    }

    #[test]
    fn native_presence_offline_url_uses_cloud_api_base() {
        assert_eq!(
            cloud_presence_offline_url("http://127.0.0.1:17081/"),
            "http://127.0.0.1:17081/v1/cloud/presence/offline"
        );
        assert_eq!(
            cloud_presence_offline_url(DEFAULT_CLOUD_API_BASE_URL),
            "https://coordinar.io/v1/cloud/presence/offline"
        );
    }

    #[test]
    fn cloud_bundle_identifier_enables_cloud_edition_without_runtime_env() {
        assert!(is_cloud_edition_context(None, None, "io.kordi.cloud"));
    }

    #[test]
    fn desktop_bundle_identifier_defaults_to_local_edition() {
        assert!(!is_cloud_edition_context(None, None, "io.kordi.desktop"));
    }

    #[test]
    fn explicit_runtime_edition_overrides_bundle_identifier() {
        assert!(is_cloud_edition_context(
            Some("cloud"),
            None,
            "io.kordi.desktop"
        ));
        assert!(!is_cloud_edition_context(
            Some("local"),
            None,
            "io.kordi.cloud"
        ));
    }
}

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
        .manage(cloud_oauth_loopback::CloudOAuthLoopbackState::default())
        .manage(DesktopAuthManager::default())
        .manage(DesktopBridgeManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let is_cloud_edition = is_cloud_edition_app(app);
            configure_cloud_app_data_dir(app, is_cloud_edition);
            activate_stored_cloud_account_data_dir(is_cloud_edition);
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
            desktop_check_for_updates,
            project::desktop_project_settings,
            project::desktop_project_create_from_folder,
            project::desktop_project_create_new,
            project::desktop_save_project_settings,
            bridge::desktop_bridge_open_config_folder,
            bridge::desktop_bridge_reveal_storage_file,
            bridge::desktop_bridge_export_hosts_config,
            bridge::desktop_bridge_import_hosts_config,
            bridge::desktop_save_bridge_host,
            bridge::desktop_remove_bridge_host,
            bridge::desktop_set_active_bridge_host,
            bridge::desktop_bridge_register_cloud_host,
            bridge::desktop_bridge_set_discovery_mode,
            bridge::desktop_bridge_set_host_privacy_policy,
            bridge::desktop_bridge_set_agent_reachability_policy,
            bridge::desktop_bridge_create_agent,
            bridge::desktop_bridge_activate_agent,
            bridge::desktop_bridge_rename_agent,
            bridge::desktop_bridge_update_agent_model_routing,
            bridge::desktop_bridge_update_local_agent_model_routing,
            bridge::desktop_bridge_set_default_agent,
            bridge::desktop_bridge_create_project,
            bridge::desktop_bridge_create_invite,
            bridge::desktop_bridge_join_project,
            bridge::desktop_bridge_add_contact,
            bridge::desktop_bridge_remove_contact,
            bridge::desktop_bridge_approve_contact_request,
            bridge::desktop_bridge_reject_contact_request,
            bridge::desktop_bridge_open_conversation,
            bridge::desktop_bridge_mark_conversation_read,
            canonical_sessions::desktop_canonical_session_state,
            canonical_sessions::desktop_canonical_upsert_identity,
            canonical_sessions::desktop_canonical_adopt_cloud_profile_identity,
            canonical_sessions::desktop_canonical_open_or_create_session,
            canonical_sessions::desktop_canonical_append_message,
            canonical_sessions::desktop_canonical_upsert_message,
            canonical_sessions::desktop_canonical_append_message_fast,
            canonical_sessions::desktop_canonical_create_delegated_exchange,
            canonical_sessions::desktop_canonical_update_presence,
            canonical_sessions::desktop_canonical_rename_session,
            canonical_sessions::desktop_canonical_update_session_metadata,
            canonical_sessions::desktop_canonical_add_session_participants,
            canonical_sessions::desktop_canonical_remove_session_participant,
            canonical_sessions::desktop_canonical_set_session_participant_role,
            auth::desktop_auth_state,
            auth::desktop_cloud_provider_auth_snapshot_payload,
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
            auth::lm_studio::desktop_lm_studio_refresh_install,
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
            chat::attachments::desktop_chat_read_attachment,
            chat::attachments::desktop_chat_download_attachment,
            chat::artifacts::desktop_chat_artifact_preview,
            chat::artifacts::desktop_chat_artifact_directory,
            chat::desktop_chat_state,
            chat::desktop_shape_agent_draft,
            chat::desktop_chat_new_session,
            chat::desktop_chat_new_project_session,
            chat::desktop_chat_prepare_draft_session,
            chat::desktop_chat_update_session_config,
            chat::desktop_chat_rename_session,
            chat::desktop_chat_archive_session,
            chat::desktop_chat_delete_session_forever,
            chat::desktop_chat_move_session_to_project,
            chat::desktop_chat_fork_session_from_message,
            chat::desktop_chat_send_message,
            chat::desktop_chat_start_message,
            chat::desktop_chat_run_skill_command,
            chat::desktop_chat_cancel_turn,
            chat::desktop_chat_turn_state,
            cloud_account_paths::cloud_account_storage_activate,
            cloud_account_paths::cloud_account_storage_current,
            cloud_account_paths::cloud_account_storage_root,
            cloud_oauth_loopback::cloud_oauth_loopback_prepare,
            cloud_oauth_loopback::cloud_oauth_loopback_wait,
            cloud_session::cloud_session_store,
            cloud_session::cloud_session_load,
            cloud_session::cloud_session_clear,
            cloud_session::cloud_device_keypair_load_or_create,
            cloud_session::cloud_bridges_api_key_store,
            cloud_session::cloud_bridges_api_key_load
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kordi desktop");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            publish_stored_cloud_presence_offline_on_exit();
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if should_hide_window_instead_of_close(&label) => {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window(&label) {
                if let Err(err) = window.hide() {
                    eprintln!("[kordi] Unable to hide window on close: {err}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } if should_show_main_window_on_reopen(has_visible_windows) => {
            if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                if let Err(err) = window.show() {
                    eprintln!("[kordi] Unable to show window on reopen: {err}");
                }
                if let Err(err) = window.set_focus() {
                    eprintln!("[kordi] Unable to focus window on reopen: {err}");
                }
            }
        }
        _ => {}
    });

    // macOS application Quit can bypass browser page lifecycle events. Run one
    // final native best-effort publish after Tauri's event loop returns so
    // explicit Quit does not wait for heartbeat timeout.
    publish_stored_cloud_presence_offline_on_exit();
}
