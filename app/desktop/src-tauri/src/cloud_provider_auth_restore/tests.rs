use super::*;

#[test]
fn restored_openai_profile_preserves_route_profile_id() {
    let imported = auth_import_from_snapshot(RestoreSnapshot {
        snapshot_id: "snap_test".to_string(),
        provider: "openai-codex".to_string(),
        auth_choice: "profile:openai-codex-original".to_string(),
        payload: json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "restore-access-secret",
            "refreshToken": "restore-refresh-secret",
            "expiresAt": 4102444800000_i64,
            "accountId": "provider-account",
            "syncActive": true,
        }),
    })
    .unwrap();

    assert_eq!(imported.provider, "openai-codex");
    assert_eq!(imported.profile_id, "openai-codex-original");
    assert!(imported.active);
    let kordi_cli::login::CloudAuthProfileSecret::OAuth { extra, .. } = &imported.secret else {
        panic!("expected OAuth import");
    };
    assert_eq!(extra["accountId"], "provider-account");
    let rendered = format!("{imported:?}");
    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("restore-access-secret"));
    assert!(!rendered.contains("restore-refresh-secret"));
}

#[test]
fn restored_legacy_default_profile_gets_stable_cloud_id() {
    let imported = auth_import_from_snapshot(RestoreSnapshot {
        snapshot_id: "snap_legacy".to_string(),
        provider: "anthropic".to_string(),
        auth_choice: "default".to_string(),
        payload: json!({
            "apiMode": "anthropic-oauth",
            "accessToken": "access",
            "refreshToken": "refresh",
            "expiresAt": 4102444800000_i64,
        }),
    })
    .unwrap();

    assert_eq!(imported.profile_id, "anthropic-oauth-cloud-snap_legacy");
}

#[test]
fn restored_github_copilot_profile_preserves_durable_and_runtime_tokens() {
    let imported = auth_import_from_snapshot(RestoreSnapshot {
        snapshot_id: "snap_copilot".to_string(),
        provider: "github-copilot".to_string(),
        auth_choice: "profile:github-copilot-original".to_string(),
        payload: json!({
            "apiMode": "github-copilot-oauth",
            "accessToken": "copilot-runtime-secret",
            "refreshToken": "github-refresh-secret",
            "githubAccessToken": "github-access-secret",
            "githubAccessExpiresAt": 4102444800000_i64,
            "runtimeExpiresAt": 4102444700000_i64,
            "accountLabel": "octocat",
            "authority": "github.example.com",
            "baseUrl": "https://api.githubcopilot.com",
        }),
    })
    .unwrap();

    assert_eq!(imported.provider, "github-copilot");
    assert_eq!(imported.profile_id, "github-copilot-original");
    let kordi_cli::login::CloudAuthProfileSecret::OAuth {
        access,
        refresh,
        extra,
        ..
    } = &imported.secret
    else {
        panic!("expected OAuth import");
    };
    assert_eq!(access, "github-access-secret");
    assert_eq!(refresh, "github-refresh-secret");
    assert_eq!(extra["copilot_token"], "copilot-runtime-secret");
    assert_eq!(extra["domain"], "github.example.com");
    assert_eq!(extra["login"], "octocat");
    assert_eq!(
        extra["copilot_api_base_url"],
        "https://api.githubcopilot.com"
    );
}

#[test]
fn restored_api_key_profile_preserves_profile_id_and_active_selection() {
    let imported = auth_import_from_snapshot(RestoreSnapshot {
        snapshot_id: "snap_api".to_string(),
        provider: "openai".to_string(),
        auth_choice: "profile:openai-key-original".to_string(),
        payload: json!({
            "apiKey": "restore-api-key-secret",
            "syncActive": true,
        }),
    })
    .unwrap();

    assert_eq!(imported.provider, "openai");
    assert_eq!(imported.profile_id, "openai-key-original");
    assert!(imported.active);
    let kordi_cli::login::CloudAuthProfileSecret::ApiKey { key } = &imported.secret else {
        panic!("expected API-key import");
    };
    assert_eq!(key, "restore-api-key-secret");
    assert!(!format!("{imported:?}").contains("restore-api-key-secret"));
}
