mod auth;
#[path = "bridge/mod.rs"]
mod bridge;
mod canonical_sessions;
mod chat;
mod cloud_account_paths;
mod cloud_oauth_loopback;
mod cloud_session;
mod project;
mod system_proxy;
#[cfg(test)]
mod test_support;
mod workspace;

use std::process::Command;

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
const PRODUCTION_CLOUD_API_HOSTNAME: &str = "coordinar.io";

fn is_production_cloud_api_url(url: &reqwest::Url) -> bool {
    url.host_str()
        .map(|hostname| {
            hostname
                .trim_end_matches('.')
                .eq_ignore_ascii_case(PRODUCTION_CLOUD_API_HOSTNAME)
        })
        .unwrap_or(false)
}

fn operator_production_debug_is_allowed(
    dev_profile: Option<&str>,
    production_debug_ack: Option<&str>,
) -> bool {
    dev_profile
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("operator"))
        && production_debug_ack.map(str::trim) == Some("1")
}

fn normalize_cloud_api_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Cloud API base URL is empty".to_string());
    }

    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "Cloud API base URL must be a valid absolute HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Cloud API base URL must use http:// or https://".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Cloud API base URL must not include credentials, a query, or a fragment".to_string(),
        );
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Cloud API base URL must be an origin without a path".to_string());
    }

    Ok(url.origin().ascii_serialization())
}

fn resolve_cloud_api_base_url(
    vite_base: Option<&str>,
    native_base: Option<&str>,
    debug_build: bool,
    dev_profile: Option<&str>,
    production_debug_ack: Option<&str>,
) -> Result<String, String> {
    let configured = vite_base
        .filter(|value| !value.trim().is_empty())
        .or_else(|| native_base.filter(|value| !value.trim().is_empty()));

    let Some(configured) = configured else {
        if debug_build {
            return Err(
                "VITE_KORDI_CLOUD_API_BASE is required for development. Start the local debug server with `pnpm debug:cloud:up`, then set its loopback URL."
                    .to_string(),
            );
        }
        return Ok(DEFAULT_CLOUD_API_BASE_URL.to_string());
    };

    let origin = normalize_cloud_api_base_url(configured)?;
    let parsed_origin = reqwest::Url::parse(&origin)
        .map_err(|_| "Cloud API base URL must be a valid absolute HTTP(S) URL".to_string())?;
    if debug_build
        && is_production_cloud_api_url(&parsed_origin)
        && !operator_production_debug_is_allowed(dev_profile, production_debug_ack)
    {
        return Err(
            "Production Cloud API is blocked in development for community profiles. Use the allowlisted operator launcher for approved production debugging."
                .to_string(),
        );
    }
    Ok(origin)
}

fn cloud_api_base_url_from_env() -> Result<String, String> {
    let vite_base = std::env::var("VITE_KORDI_CLOUD_API_BASE").ok();
    let native_base = std::env::var("KORDI_CLOUD_API_BASE").ok();
    let dev_profile = std::env::var("VITE_KORDI_DEV_PROFILE").ok();
    let production_debug_ack = std::env::var("VITE_KORDI_PRODUCTION_DEBUG_ACK").ok();
    resolve_cloud_api_base_url(
        vite_base.as_deref(),
        native_base.as_deref(),
        cfg!(debug_assertions),
        dev_profile.as_deref(),
        production_debug_ack.as_deref(),
    )
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
    let base_url = match cloud_api_base_url_from_env() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[kordi] Unable to publish Cloud presence offline on quit: {err}");
            return;
        }
    };
    let token = session.token;
    if let Err(err) = publish_cloud_presence_offline(&token, &base_url) {
        eprintln!("[kordi] Unable to publish Cloud presence offline on quit: {err}");
    }
}

#[cfg(test)]
mod window_lifecycle_tests {
    use super::{
        cloud_presence_offline_url, is_cloud_edition_context, resolve_cloud_api_base_url,
        should_hide_window_instead_of_close, should_publish_presence_offline_on_exit,
        should_show_main_window_on_reopen, DEFAULT_CLOUD_API_BASE_URL,
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
    fn debug_build_requires_an_explicit_non_production_cloud_api() {
        assert!(resolve_cloud_api_base_url(None, None, true, None, None)
            .unwrap_err()
            .contains("required for development"));
        assert!(
            resolve_cloud_api_base_url(Some("https://coordinar.io/"), None, true, None, None)
                .unwrap_err()
                .contains("blocked in development")
        );
        assert!(
            resolve_cloud_api_base_url(Some("http://coordinar.io"), None, true, None, None)
                .unwrap_err()
                .contains("blocked in development")
        );
        assert!(
            resolve_cloud_api_base_url(Some("https://coordinar.io./"), None, true, None, None)
                .unwrap_err()
                .contains("blocked in development")
        );
        assert_eq!(
            resolve_cloud_api_base_url(Some(" http://127.0.0.1:17081/ "), None, true, None, None,)
                .unwrap(),
            "http://127.0.0.1:17081"
        );
    }

    #[test]
    fn operator_debug_requires_profile_and_explicit_production_acknowledgement() {
        assert!(resolve_cloud_api_base_url(
            Some(DEFAULT_CLOUD_API_BASE_URL),
            None,
            true,
            Some("operator"),
            None,
        )
        .is_err());
        assert!(resolve_cloud_api_base_url(
            Some(DEFAULT_CLOUD_API_BASE_URL),
            None,
            true,
            Some("community"),
            Some("1"),
        )
        .is_err());
        assert_eq!(
            resolve_cloud_api_base_url(
                Some(DEFAULT_CLOUD_API_BASE_URL),
                None,
                true,
                Some("operator"),
                Some("1"),
            )
            .unwrap(),
            DEFAULT_CLOUD_API_BASE_URL,
        );
    }

    #[test]
    fn release_build_keeps_the_product_default() {
        assert_eq!(
            resolve_cloud_api_base_url(None, None, false, None, None).unwrap(),
            DEFAULT_CLOUD_API_BASE_URL
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
    system_proxy::install_native_proxy_environment();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(cloud_oauth_loopback::CloudOAuthLoopbackState::default())
        .manage(DesktopAuthManager::default())
        .manage(DesktopBridgeManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let is_cloud_edition = is_cloud_edition_app(app);
            if is_cloud_edition {
                cloud_api_base_url_from_env().map_err(std::io::Error::other)?;
            }
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
            canonical_sessions::desktop_canonical_session_catalog,
            canonical_sessions::desktop_canonical_session_messages,
            canonical_sessions::desktop_canonical_upsert_identity,
            canonical_sessions::desktop_canonical_adopt_cloud_profile_identity,
            canonical_sessions::desktop_canonical_upsert_identity_fast,
            canonical_sessions::desktop_canonical_open_or_create_session_fast,
            canonical_sessions::desktop_canonical_open_or_create_session,
            canonical_sessions::desktop_canonical_append_message,
            canonical_sessions::desktop_canonical_upsert_message,
            canonical_sessions::desktop_canonical_upsert_message_fast,
            canonical_sessions::desktop_canonical_update_message_delivery,
            canonical_sessions::desktop_canonical_append_message_fast,
            canonical_sessions::desktop_canonical_create_delegated_exchange,
            canonical_sessions::desktop_canonical_update_presence,
            canonical_sessions::desktop_canonical_rename_session,
            canonical_sessions::desktop_canonical_update_session_metadata,
            canonical_sessions::desktop_canonical_add_session_participants,
            canonical_sessions::desktop_canonical_remove_session_participant,
            canonical_sessions::desktop_canonical_set_session_participant_role,
            canonical_sessions::desktop_canonical_mark_session_read,
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
            chat::desktop_chat_session_detail,
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
