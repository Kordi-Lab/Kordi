mod auth;
mod canonical_sessions;
mod chat;
mod cloud_account_paths;
mod cloud_api_endpoint;
use canonical_sessions::desktop_canonical_reconcile_message_mirror;
use cloud_api_endpoint::cloud_api_base_url_from_env;
mod cloud_oauth_loopback;
mod cloud_presence;
mod cloud_session;
mod project;
mod remote_image;
mod skill_library;
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
        _ => {
            bundle_identifier == "io.kordi.cloud"
                || bundle_identifier.starts_with("io.kordi.cloud.")
        }
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
    // The Cloud bundle identifier gives ~/.korde isolated storage.
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
use chat::DesktopChatManager;
use cloud_presence::publish_stored_offline_on_exit;
use tauri::Manager;
use workspace::DesktopWorkspaceStatus;

const MAIN_WINDOW_LABEL: &str = "main";

fn should_hide_window_instead_of_close(label: &str) -> bool {
    cfg!(target_os = "macos") && label == MAIN_WINDOW_LABEL
}

fn should_show_main_window_on_reopen(has_visible_windows: bool) -> bool {
    cfg!(target_os = "macos") && !has_visible_windows
}

#[cfg(test)]
mod window_lifecycle_tests {
    use super::{
        is_cloud_edition_context, should_hide_window_instead_of_close,
        should_show_main_window_on_reopen,
    };
    use crate::cloud_api_endpoint::DEFAULT_CLOUD_API_BASE_URL;
    use crate::cloud_presence::{offline_url, should_publish_offline_on_exit};

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
        assert!(should_publish_offline_on_exit());
    }

    #[test]
    fn native_presence_offline_url_uses_cloud_api_base() {
        assert_eq!(
            offline_url("http://127.0.0.1:17081/"),
            "http://127.0.0.1:17081/v1/cloud/presence/offline"
        );
        assert_eq!(
            offline_url(DEFAULT_CLOUD_API_BASE_URL),
            "https://kordi.ai/v1/cloud/presence/offline"
        );
    }

    #[test]
    fn cloud_bundle_identifier_enables_cloud_edition_without_runtime_env() {
        assert!(is_cloud_edition_context(None, None, "io.kordi.cloud"));
        assert!(is_cloud_edition_context(
            None,
            None,
            "io.kordi.cloud.factory-preview"
        ));
    }

    #[test]
    fn cloud_preview_bundle_identifier_uses_isolated_cloud_storage() {
        assert!(is_cloud_edition_context(
            None,
            None,
            "io.kordi.cloud.group-management-preview"
        ));
        assert!(!is_cloud_edition_context(None, None, "io.kordi.cloudish"));
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(cloud_oauth_loopback::CloudOAuthLoopbackState::default())
        .manage(DesktopAuthManager::default())
        .manage(DesktopChatManager::default())
        .setup(|app| {
            let is_cloud_edition = is_cloud_edition_app(app);
            if is_cloud_edition {
                cloud_api_base_url_from_env().map_err(std::io::Error::other)?;
            }
            configure_cloud_app_data_dir(app, is_cloud_edition);
            activate_stored_cloud_account_data_dir(is_cloud_edition);
            if let Err(err) = chat::allow_attachment_asset_scope(app) {
                eprintln!("[kordi] Unable to allow attachment preview assets: {err}");
            }
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
            canonical_sessions::desktop_canonical_session_state,
            canonical_sessions::desktop_canonical_session_catalog,
            canonical_sessions::desktop_canonical_session_messages,
            canonical_sessions::desktop_canonical_existing_message_sources,
            canonical_sessions::desktop_canonical_upsert_identity,
            canonical_sessions::desktop_canonical_adopt_cloud_profile_identity,
            canonical_sessions::desktop_canonical_upsert_identity_fast,
            canonical_sessions::desktop_canonical_open_or_create_session_fast,
            canonical_sessions::desktop_canonical_open_or_create_session,
            canonical_sessions::desktop_canonical_append_message,
            canonical_sessions::desktop_canonical_upsert_message,
            canonical_sessions::desktop_canonical_upsert_message_fast,
            desktop_canonical_reconcile_message_mirror,
            canonical_sessions::desktop_canonical_list_legacy_cloud_group_title_notice_ids,
            canonical_sessions::desktop_canonical_classify_legacy_cloud_group_title_notices,
            canonical_sessions::desktop_canonical_update_message_delivery,
            canonical_sessions::desktop_canonical_append_message_fast,
            canonical_sessions::desktop_canonical_create_delegated_exchange,
            canonical_sessions::desktop_canonical_update_presence,
            canonical_sessions::desktop_canonical_rename_session,
            canonical_sessions::desktop_canonical_update_session_metadata,
            canonical_sessions::desktop_canonical_add_session_participants,
            canonical_sessions::desktop_canonical_add_group_members_fast,
            canonical_sessions::desktop_canonical_remove_session_participant,
            canonical_sessions::desktop_canonical_set_session_participant_role,
            canonical_sessions::desktop_canonical_mark_session_read,
            canonical_sessions::chat_sync::desktop_chat_sync_apply,
            canonical_sessions::chat_sync::desktop_chat_sync_load,
            canonical_sessions::chat_sync::desktop_chat_sync_outbox_enqueue,
            canonical_sessions::chat_sync::desktop_chat_sync_outbox_due,
            canonical_sessions::chat_sync::desktop_chat_sync_outbox_complete,
            canonical_sessions::chat_sync::desktop_chat_sync_outbox_fail,
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
            chat::agent_builder::catalog::desktop_agent_builder_list,
            chat::agent_builder::catalog::desktop_agent_builder_resolve,
            chat::agent_builder::catalog::desktop_agent_builder_open,
            chat::agent_builder::catalog::desktop_agent_builder_open_session,
            chat::agent_builder::catalog::desktop_agent_builder_recover,
            chat::agent_builder::catalog::desktop_agent_builder_retarget,
            chat::agent_builder::desktop_agent_builder_status,
            chat::agent_builder::desktop_agent_builder_read_file,
            chat::agent_builder::desktop_agent_builder_write_file,
            chat::agent_builder::desktop_agent_builder_update_draft,
            chat::agent_builder::desktop_agent_builder_test,
            chat::agent_builder::desktop_agent_builder_mark_published,
            chat::agent_builder::desktop_agent_builder_install_skill,
            chat::agent_builder::desktop_agent_builder_discard,
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
            skill_library::desktop_skill_library_list,
            skill_library::desktop_skill_library_detail,
            skill_library::desktop_skill_library_read_file,
            skill_library::desktop_skill_library_write_file,
            skill_library::desktop_skill_library_set_enabled,
            skill_library::desktop_skill_library_remove,
            skill_library::desktop_skill_community_providers,
            skill_library::desktop_skill_community_search,
            skill_library::desktop_skill_community_detail,
            skill_library::desktop_skill_community_install,
            cloud_account_paths::cloud_account_storage_activate,
            cloud_account_paths::cloud_account_storage_current,
            cloud_account_paths::cloud_account_storage_root,
            cloud_oauth_loopback::cloud_oauth_loopback_prepare,
            cloud_oauth_loopback::cloud_oauth_loopback_wait,
            cloud_session::cloud_session_store,
            cloud_session::cloud_session_load,
            cloud_session::cloud_session_clear,
            remote_image::desktop_fetch_remote_image_data_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kordi desktop");
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            publish_stored_offline_on_exit();
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
    // macOS Quit can bypass browser lifecycle, so publish once after Tauri exits.
    publish_stored_offline_on_exit();
}
