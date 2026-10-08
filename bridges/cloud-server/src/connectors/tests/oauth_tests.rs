//! Providers, sealing, and the OAuth flow.

use super::*;

// ---------------------------------------------------------------------------
// Providers, sealing, OAuth helpers

#[test]
fn provider_catalog_has_read_and_act_scopes_for_every_provider() {
    let ids = providers::PROVIDER_SPECS
        .iter()
        .map(|spec| spec.id)
        .collect::<Vec<_>>();
    assert_eq!(ids, ["google_calendar", "gmail", "github", "slack"]);
    for spec in providers::PROVIDER_SPECS {
        assert!(!spec.read_scopes.is_empty() && !spec.act_scopes.is_empty());
        assert!(spec
            .read_scopes
            .iter()
            .all(|scope| !spec.act_scopes.contains(scope)));
        assert!(providers::client_id_env(spec).starts_with("KORDI_CONNECTOR_"));
        assert!(!providers::client_id_env(spec).contains("OAUTH"));
    }
    assert!(providers::provider_spec("outlook").is_none());
    assert!(providers::NOT_YET_AVAILABLE_PROVIDERS.contains(&"outlook"));
}

#[test]
fn oauth_client_requires_both_halves() {
    assert!(providers::oauth_client_from_values("id", " ", "https://kordi.ai").is_none());
    assert!(providers::oauth_client_from_values("", "secret", "https://kordi.ai").is_none());
    let client = providers::oauth_client_from_values("id", "secret", "https://kordi.ai/").unwrap();
    assert_eq!(
        client.redirect_uri,
        "https://kordi.ai/v1/cloud/connectors/oauth/callback"
    );
    assert!(!format!("{client:?}").contains("secret\""));
}

#[test]
fn auth_url_carries_grant_scopes_state_and_pkce() {
    let client = providers::oauth_client_from_values("cid", "csecret", "https://kordi.ai").unwrap();
    let url = url::Url::parse(&oauth::build_auth_url(
        &providers::GMAIL,
        &client,
        ConnectorToolGroup::Act,
        "state_1",
        "verifier",
    ))
    .unwrap();
    let pairs = url
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(pairs["state"], "state_1");
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(pairs["access_type"], "offline");
    let scopes = pairs["scope"].split(' ').collect::<Vec<_>>();
    assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.readonly"));
    assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.send"));
    assert!(!url.as_str().contains("csecret"));

    // The first connect (`read` grant) asks for read and act together.
    let connect = oauth::build_auth_url(
        &providers::SLACK,
        &client,
        ConnectorToolGroup::Read,
        "state_2",
        "verifier",
    );
    let slack = url::Url::parse(&connect).unwrap();
    let user_scope = slack
        .query_pairs()
        .find(|(key, _)| key == "user_scope")
        .unwrap()
        .1
        .to_string();
    assert_eq!(providers::SLACK.scope_param, ScopeParam::SlackUserScope);
    assert!(user_scope.contains("channels:history") && user_scope.contains("chat:write"));
    assert!(!connect.contains("code_challenge"));
}

#[test]
fn granted_scopes_are_split_into_read_and_act() {
    let (read, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Act, None);
    assert_eq!(read, ["read:user", "notifications"]);
    assert_eq!(act, ["repo"]);
    let granted = vec!["read:user".to_string()];
    let (read, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Act, Some(&granted));
    assert_eq!(read, ["read:user"]);
    assert!(act.is_empty(), "act scopes the person unchecked stay off");
    // The connect grant asks for act too, so its act scopes count.
    let (read, act) =
        oauth::classify_granted_scopes(&providers::GITHUB, ConnectorToolGroup::Read, None);
    assert_eq!(read, ["read:user", "notifications"]);
    assert_eq!(act, ["repo"]);
}

#[test]
fn token_responses_normalize_across_providers() {
    let now = Utc::now();
    let google = providers::token_grant_from_json(
        &json!({"access_token":"a","refresh_token":"r","expires_in":3600,"scope":"x y"}),
        None,
        now,
    )
    .unwrap();
    assert_eq!(google.secret.refresh_token.as_deref(), Some("r"));
    assert_eq!(
        google.secret.expires_at,
        Some(now + ChronoDuration::seconds(3600))
    );
    assert_eq!(google.granted_scopes.unwrap(), ["x", "y"]);

    let slack = providers::token_grant_from_json(
        &json!({"ok":true,"authed_user":{"access_token":"u","scope":"a,b"}}),
        Some("kept"),
        now,
    )
    .unwrap();
    assert_eq!(slack.secret.access_token, "u");
    assert_eq!(slack.secret.refresh_token.as_deref(), Some("kept"));
    assert_eq!(slack.granted_scopes.unwrap(), ["a", "b"]);

    assert!(
        providers::token_grant_from_json(&json!({"ok":false,"error":"bad"}), None, now).is_err()
    );
    assert!(providers::token_grant_from_json(&json!({}), None, now).is_err());
}

#[test]
fn sealed_secrets_split_nonce_and_round_trip() {
    let secret = ConnectorSecret {
        access_token: "access-value".into(),
        refresh_token: Some("refresh-value".into()),
        expires_at: Some(Utc::now()),
    };
    let sealed = broker::seal_secret(&TestCipher, &secret).unwrap();
    assert_eq!(sealed.nonce.len(), 12);
    assert_eq!(sealed.key_version, 3);
    assert!(!String::from_utf8_lossy(&sealed.ciphertext).contains("access-value"));
    assert_eq!(broker::open_secret(&TestCipher, &sealed).unwrap(), secret);
    assert_eq!(broker::key_version_from_id("env:v1"), 1);
    assert_eq!(broker::key_version_from_id("local-debug:v12"), 12);
    assert_eq!(broker::key_version_from_id("custom"), 1);
}

// ---------------------------------------------------------------------------
// 6. OAuth state helper

fn sample_state(expires_in_minutes: i64) -> ConnectorOAuthState {
    ConnectorOAuthState {
        state_id: "connector_state_x".into(),
        account_id: "acct_owner".into(),
        provider: "github".into(),
        grant: ConnectorToolGroup::Read,
        redirect_after: None,
        code_verifier: "verifier".into(),
        expires_at: Utc::now() + ChronoDuration::minutes(expires_in_minutes),
    }
}

#[test]
fn consumed_state_is_checked_for_use_and_expiry() {
    let now = Utc::now();
    let live = oauth::check_consumed_state(Some(sample_state(10)), now).unwrap();
    assert_eq!(live.account_id, "acct_owner");
    assert_eq!(
        oauth::check_consumed_state(None, now),
        Err(StateError::UnknownOrUsed)
    );
    assert_eq!(
        oauth::check_consumed_state(Some(sample_state(-1)), now),
        Err(StateError::Expired)
    );
}

#[test]
fn callback_redirects_carry_the_result_in_the_fragment() {
    let ok = oauth::CallbackOutcome {
        redirect_after: Some("kordi-beta://oauth/callback".into()),
        result: Ok(OAuthPendingFragment {
            completion_code: "connector_completion_1".into(),
            provider: "github".into(),
            grant: ConnectorToolGroup::Read,
            status: PENDING_GRANT_STATUS,
        }),
    };
    let url = oauth::callback_redirect_url("kordi-beta://oauth/callback", &ok);
    let encoded = url
        .strip_prefix("kordi-beta://oauth/callback#kordi_connector=")
        .unwrap();
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({
            "completionCode": "connector_completion_1",
            "provider": "github",
            "grant": "read",
            "status": "pending"
        })
    );
    let failed = oauth::CallbackOutcome {
        redirect_after: None,
        result: Err(oauth::CallbackError {
            code: "provider_denied",
            message: "Access was not granted.".into(),
        }),
    };
    let url = oauth::callback_redirect_url("http://127.0.0.1:1420/x#a=1", &failed);
    assert!(url.ends_with(
        "#a=1&kordi_connector_error=Access%20was%20not%20granted.&kordi_connector_error_code=provider_denied"
    ));
}

#[test]
fn event_retention_defaults_to_thirty_days() {
    assert_eq!(events::retention_days_from(None), 30);
    assert_eq!(events::retention_days_from(Some("7")), 7);
    assert_eq!(events::retention_days_from(Some("0")), 30);
    assert_eq!(events::retention_days_from(Some("9999")), 30);
    assert_eq!(events::retention_days_from(Some("x")), 30);
}

#[tokio::test]
async fn oauth_state_is_one_use_and_bound_to_the_account() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "state_owner").await;
    let auth_url = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        STUB.id,
        ConnectorToolGroup::Read,
        None,
    )
    .await
    .unwrap();
    let state_id = state_from_auth_url(&auth_url);
    let first = oauth::complete_grant(&pool, &runtime, Some(&state_id), Some("c1"), None).await;
    let code = first.result.unwrap().completion_code;
    let connector_id = oauth_complete::finish_grant(&pool, &runtime, &owner, &code)
        .await
        .unwrap()
        .connector_id;
    let stored = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .expect("the grant lands on the account that started it");
    assert_eq!(stored.read_scopes, ["stub.read"]);
    assert_eq!(stored.act_scopes, ["stub.act"]);
    assert!(stored.act_enabled, "connect grants read and act together");

    let replay = oauth::complete_grant(&pool, &runtime, Some(&state_id), Some("c2"), None).await;
    assert_eq!(replay.result.unwrap_err().code, "invalid_oauth_state");
    assert_eq!(
        stub.calls(),
        ["exchange:c1"],
        "a replayed state never exchanges"
    );

    let outlook = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        "outlook",
        ConnectorToolGroup::Read,
        None,
    )
    .await;
    assert!(matches!(outlook, Err(oauth::StartError::NotYetAvailable)));
    let unknown = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        "myspace",
        ConnectorToolGroup::Read,
        None,
    )
    .await;
    assert!(matches!(unknown, Err(oauth::StartError::UnknownProvider)));
}
