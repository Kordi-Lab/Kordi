use serde_json::json;

use super::{
    github_profile_from_values, is_allowed_oauth_redirect_with_config,
    oauth_credentials_are_complete, oauth_error_redirect_url, oauth_not_configured_message,
    public_base_url, OAuthProvider,
};

#[test]
fn oauth_credentials_require_both_non_empty_values() {
    assert!(oauth_credentials_are_complete("client-id", "client-secret"));
    assert!(!oauth_credentials_are_complete("", "client-secret"));
    assert!(!oauth_credentials_are_complete("client-id", ""));
    assert!(!oauth_credentials_are_complete("   ", "client-secret"));
}

#[test]
fn unavailable_oauth_message_is_safe_and_actionable() {
    let message = oauth_not_configured_message(OAuthProvider::Google);
    assert_eq!(
        message,
        "Google sign-in is not available on this server. Use email and password."
    );
    assert!(!message.contains("KORDI_OAUTH_"));
}

#[test]
fn public_base_url_defaults_to_product_cloud_host() {
    std::env::remove_var("KORDI_CLOUD_PUBLIC_BASE_URL");

    assert_eq!(public_base_url(), "https://kordi.ai");
}

#[test]
fn redirect_allowlist_rejects_prefix_host_spoofing() {
    assert!(!is_allowed_oauth_redirect_with_config(
        "https://kordi.ai.evil.example/callback",
        None,
        "https://kordi.ai",
    ));
    assert!(is_allowed_oauth_redirect_with_config(
        "https://kordi.ai/callback",
        None,
        "https://kordi.ai",
    ));
}

#[test]
fn redirect_allowlist_accepts_loopback_but_not_arbitrary_tauri_scheme() {
    assert!(is_allowed_oauth_redirect_with_config(
        "http://127.0.0.1:49152/oauth/request",
        None,
        "https://kordi.ai",
    ));
    assert!(!is_allowed_oauth_redirect_with_config(
        "tauri://localhost/oauth/request",
        None,
        "https://kordi.ai",
    ));
}

#[test]
fn redirect_allowlist_accepts_only_the_configured_native_callback() {
    let allowlist = Some("kordi://oauth/callback");
    assert!(is_allowed_oauth_redirect_with_config(
        "kordi://oauth/callback",
        allowlist,
        "https://kordi.ai",
    ));
    assert!(!is_allowed_oauth_redirect_with_config(
        "kordi://oauth/other",
        allowlist,
        "https://kordi.ai",
    ));
    assert!(!is_allowed_oauth_redirect_with_config(
        "evil-kordi://oauth/callback",
        allowlist,
        "https://kordi.ai",
    ));
}

#[test]
fn github_profile_uses_only_verified_primary_email_for_account_linking() {
    let user = json!({
        "id": 123,
        "login": "octo",
        "name": "Octo Cat",
        "email": "unverified@example.com",
        "avatar_url": "https://avatars.example/octo.png"
    });
    let emails = json!([
        { "email": "unverified@example.com", "primary": true, "verified": false },
        { "email": "verified-secondary@example.com", "primary": false, "verified": true }
    ]);

    let profile = github_profile_from_values(&user, &emails);

    assert_eq!(profile.provider_subject, "123");
    assert_eq!(profile.email, None);
    assert!(!profile.email_verified);
}

#[test]
fn github_profile_keeps_verified_primary_email_for_account_linking() {
    let user = json!({ "id": 123, "login": "octo" });
    let emails = json!([
        { "email": "octo@example.com", "primary": true, "verified": true }
    ]);

    let profile = github_profile_from_values(&user, &emails);

    assert_eq!(profile.email.as_deref(), Some("octo@example.com"));
    assert!(profile.email_verified);
}

#[test]
fn oauth_error_redirect_keeps_message_and_adds_optional_code() {
    assert_eq!(
        oauth_error_redirect_url("kordi://oauth/callback", "Access denied", None),
        "kordi://oauth/callback#kordi_cloud_oauth_error=Access%20denied"
    );
    assert_eq!(
        oauth_error_redirect_url(
            "http://127.0.0.1:4100/oauth/request#state",
            "Sign in with your email & password.",
            Some("oauth_email_requires_sign_in"),
        ),
        "http://127.0.0.1:4100/oauth/request#state&kordi_cloud_oauth_error=\
         Sign%20in%20with%20your%20email%20%26%20password.\
         &kordi_cloud_oauth_error_code=oauth_email_requires_sign_in"
    );
}
