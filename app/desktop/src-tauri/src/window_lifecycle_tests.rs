use super::is_cloud_edition_context;
use crate::cloud_api_endpoint::DEFAULT_CLOUD_API_BASE_URL;
use crate::cloud_presence::{offline_url, should_publish_offline_on_exit};

#[test]
fn update_restart_skips_presence_offline() {
    assert!(should_publish_offline_on_exit(None));
    assert!(should_publish_offline_on_exit(Some(0)));
    assert!(!should_publish_offline_on_exit(Some(
        tauri::RESTART_EXIT_CODE
    )));
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
