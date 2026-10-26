use super::*;
use std::collections::HashMap;

#[test]
fn system_agent_is_off_without_a_key() {
    let values: HashMap<&str, &str> = HashMap::new();
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap();
    assert!(config.is_none());
}

#[test]
fn system_agent_is_on_whenever_a_key_is_configured_unless_switched_off() {
    let on = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test")]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| on
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_some());
    let off = HashMap::from([
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
        ("KORDI_SYSTEM_AGENT_ENABLED", "false"),
    ]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| off
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_none());
}

#[test]
fn grounding_credentials_can_be_enabled_without_group_chat_automation() {
    for name in [
        "KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED",
        "KORDI_PIP_GROUP_CHAT_ENABLED",
    ] {
        let config = configured(&[
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
            (name, "false"),
        ])
        .expect("Grounding service remains available");
        assert!(!config.group_chat_enabled);
        assert_eq!(config.provider_auth.api_key(), "synthetic-key");
    }
    let config = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-key"),
        ("KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED", "true"),
        ("KORDI_PIP_GROUP_CHAT_ENABLED", "false"),
    ])
    .unwrap();
    assert!(
        config.group_chat_enabled,
        "the new setting takes precedence"
    );
}

#[test]
fn enabled_system_agent_requires_its_own_api_key() {
    let values = HashMap::from([("KORDI_SYSTEM_AGENT_ENABLED", "true")]);
    let error =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap_err();
    assert!(matches!(error, SystemAgentConfigError::Invalid(_)));
}

#[test]
fn defaults_fill_everything_but_the_key() {
    let values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "yes"),
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", " sk-test "),
    ]);
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
            .unwrap();
    assert!(config.group_chat_enabled);
    assert_eq!(config.account_id, DEFAULT_SYSTEM_AGENT_ACCOUNT_ID);
    assert_eq!(config.agent_id, DEFAULT_SYSTEM_AGENT_ID);
    assert_eq!(config.name, "System");
    assert_eq!(config.provider_auth.api_key(), "sk-test");
    assert_eq!(
        config.provider_auth.model(),
        DEFAULT_SYSTEM_AGENT_OPENAI_MODEL
    );
    assert!(!format!("{:?}", config.provider_auth).contains("sk-test"));
}

fn lookup(extra: Option<&'static str>) -> Result<PendingSystemAgentConfig, SystemAgentConfigError> {
    let mut values = HashMap::from([("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test")]);
    if let Some(url) = extra {
        values.insert("KORDI_SYSTEM_AGENT_OPENAI_BASE_URL", url);
    }
    PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
        .map(|config| config.expect("configured"))
}

#[test]
fn base_url_defaults_to_openai_when_unset() {
    let config = lookup(None).unwrap();
    assert_eq!(
        config.provider_auth.base_url(),
        DEFAULT_SYSTEM_AGENT_OPENAI_BASE_URL
    );
}

#[test]
fn base_url_override_is_used_and_trailing_slash_stripped() {
    let config = lookup(Some(" https://gateway.example.invalid/v1/ ")).unwrap();
    assert_eq!(
        config.provider_auth.base_url(),
        "https://gateway.example.invalid/v1"
    );
    let config = lookup(Some("http://127.0.0.1:4000/v1")).unwrap();
    assert_eq!(config.provider_auth.base_url(), "http://127.0.0.1:4000/v1");
}

fn configured(values: &[(&str, &str)]) -> Option<PendingSystemAgentConfig> {
    let values: HashMap<&str, &str> = values.iter().copied().collect();
    PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
        .unwrap()
}

#[test]
fn new_and_old_setting_names_are_both_read() {
    let new = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        ("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "model-new"),
    ])
    .unwrap();
    assert_eq!(new.provider_auth.api_key(), "sk-new");
    assert_eq!(new.provider_auth.model(), "model-new");
    let old = configured(&[
        ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
        ("KORDI_PIP_OPENAI_MODEL", "model-old"),
        ("KORDI_PIP_OWNER_EMAIL", "old@example.invalid"),
    ])
    .unwrap();
    assert_eq!(old.provider_auth.api_key(), "sk-old");
    assert_eq!(old.provider_auth.model(), "model-old");
    assert_eq!(old.owner_email, "old@example.invalid");
}

#[test]
fn the_new_setting_name_wins_over_the_old_one() {
    let config = configured(&[
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        ("KORDI_PIP_OPENAI_API_KEY", "sk-old"),
        ("KORDI_SYSTEM_AGENT_AGENT_NAME", " "),
        ("KORDI_PIP_AGENT_NAME", "Old name"),
    ])
    .unwrap();
    assert_eq!(config.provider_auth.api_key(), "sk-new");
    assert_eq!(config.name, "Old name", "a blank new value falls back");
    let on = [
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-new"),
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_PIP_ENABLED", "false"),
    ];
    assert!(configured(&on).is_some());
}

#[test]
fn either_enabled_name_switches_it_off() {
    for name in ["KORDI_SYSTEM_AGENT_ENABLED", "KORDI_PIP_ENABLED"] {
        let values = [
            ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "sk-test"),
            (name, "false"),
        ];
        assert!(configured(&values).is_none(), "{name}");
    }
}

#[test]
fn non_https_base_url_is_rejected() {
    for bad in [
        "http://gateway.example.invalid/v1",
        "ftp://x",
        "gateway.example.invalid",
        "http://localhost.evil.invalid/v1",
    ] {
        let error = lookup(Some(bad)).unwrap_err();
        assert!(
            matches!(error, SystemAgentConfigError::Invalid(m) if m == "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL must be an https URL"),
            "{bad}"
        );
    }
}
#[test]
fn vertex_service_uses_explicit_model_without_an_openai_key() {
    let mut values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
        ("KORDI_SYSTEM_AGENT_PROVIDER", "vertex-ai"),
        ("KORDI_SERVICE_VERTEX_PROJECT", "synthetic-project"),
        ("KORDI_SYSTEM_AGENT_VERTEX_MODEL", "google/synthetic-model"),
    ]);
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|value| value.to_string()))
            .unwrap()
            .unwrap();
    assert_eq!(config.provider_auth.provider(), "vertex-ai");
    assert_eq!(config.provider_auth.model(), "google/synthetic-model");
    assert!(config.provider_auth.credential().is_google_cloud());
    assert!(config
        .provider_auth
        .base_url()
        .starts_with("https://aiplatform.googleapis.com/"));
    // Selecting Vertex never silently falls back to an existing OpenAI key.
    values.insert("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret");
    values.remove("KORDI_SYSTEM_AGENT_VERTEX_MODEL");
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .is_err());
    values.insert("KORDI_SYSTEM_AGENT_ENABLED", "false");
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .unwrap()
    .is_none());
}

#[test]
fn service_rejects_unknown_provider() {
    let values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_ENABLED", "true"),
        ("KORDI_SYSTEM_AGENT_OWNER_EMAIL", "support@example.invalid"),
        ("KORDI_SYSTEM_AGENT_PROVIDER", "typo"),
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "unused-secret"),
    ]);
    assert!(PendingSystemAgentConfig::from_lookup(|key| values
        .get(key)
        .map(|value| value.to_string()))
    .is_err());
}
