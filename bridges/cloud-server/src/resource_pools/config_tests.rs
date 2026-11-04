use std::collections::HashMap;

use serde_json::{json, Value};

use super::*;
use crate::resource_pools::Feature;
use crate::system_agent::PendingSystemAgentConfig;

const SHARED_KEY: &str = "synthetic-shared-pool-key";
const PARTNER_KEY: &str = "synthetic-partner-pool-key";

fn env(key: &str) -> Option<String> {
    match key {
        "KORDI_POOL_SHARED_KEY" => Some(SHARED_KEY.to_string()),
        "KORDI_POOL_PARTNER_KEY" => Some(PARTNER_KEY.to_string()),
        _ => None,
    }
}

/// A shared default pool through an OpenRouter-style gateway, limited to 3
/// System agent runs per conversation, and a partner pool for one
/// organization.
fn two_pools() -> Value {
    json!({
        "version": 1,
        "defaultPool": "shared",
        "pools": [
            {
                "id": "shared",
                "systemAgent": {
                    "provider": "openrouter",
                    "baseUrl": "https://gateway.example.test/api/v1/",
                    "model": "vendor/synthetic-model",
                    "apiKeyEnv": "KORDI_POOL_SHARED_KEY",
                    "headers": {"HTTP-Referer": "https://app.example.test", "X-Title": "Example"},
                    "estimatedCostMicrosPerRun": 1500
                },
                "limits": {"systemAgentRunsPerConversationPerDay": 3}
            },
            {
                "id": "partner",
                "systemAgent": {
                    "baseUrl": "https://models.example.test/v1",
                    "model": "partner-model",
                    "apiKeyEnv": "KORDI_POOL_PARTNER_KEY"
                },
                "grounding": {
                    "provider": "openai-compatible",
                    "baseUrl": "https://models.example.test/v1",
                    "model": "partner-small-model",
                    "apiKeyEnv": "KORDI_POOL_PARTNER_KEY"
                },
                "limits": {
                    "groundingRunsPerPersonPerDay": 5,
                    "poolRunsPerDay": 1000,
                    "poolSpendMicrosPerDay": 2000000
                },
                "organizations": ["org_partner_a", "org_partner_b"]
            }
        ]
    })
}

fn parse_value(value: &Value) -> Result<ResourcePools, ResourcePoolConfigError> {
    parse(&value.to_string(), env)
}

#[test]
fn a_pool_file_defines_providers_limits_and_bindings() {
    let pools = parse_value(&two_pools()).expect("valid pool file");
    let shared = pools.default_pool();
    assert_eq!(shared.id(), "shared");
    let provider = shared.provider(Feature::SystemAgent);
    assert_eq!(provider.auth().provider(), "openrouter");
    assert_eq!(
        provider.auth().base_url(),
        "https://gateway.example.test/api/v1"
    );
    assert_eq!(provider.auth().model(), "vendor/synthetic-model");
    assert_eq!(provider.auth().api_key(), SHARED_KEY);
    assert_eq!(provider.estimated_cost_micros(), 1500);
    assert_eq!(
        provider.headers().get("http-referer").map(String::as_str),
        Some("https://app.example.test")
    );
    assert_eq!(
        provider.headers().get("x-title").map(String::as_str),
        Some("Example")
    );
    // Grounding shares the System agent provider unless the pool names one.
    assert_eq!(
        shared.provider(Feature::Grounding).auth().model(),
        "vendor/synthetic-model"
    );
    assert_eq!(shared.limits().system_agent_runs_per_conversation, Some(3));
    assert_eq!(shared.limits().grounding_runs_per_person, None);
    assert!(!shared.is_stopped());

    let partner = pools.by_id("partner").unwrap();
    assert_eq!(
        partner.provider(Feature::SystemAgent).auth().provider(),
        "openai"
    );
    assert_eq!(
        partner.provider(Feature::Grounding).auth().model(),
        "partner-small-model"
    );
    assert_eq!(partner.limits().grounding_runs_per_person, Some(5));
    assert_eq!(partner.limits().pool_runs, Some(1000));
    assert_eq!(partner.limits().pool_spend_micros, Some(2_000_000));

    let route = shared.routing(Feature::SystemAgent);
    assert_eq!(
        route,
        json!({
            "defaultModel": "vendor/synthetic-model",
            "defaultAuthProvider": "openrouter",
            "defaultAuthChoice": "pip-service-api-key",
            "resourcePool": "shared",
        })
    );
}

#[test]
fn organizations_resolve_to_their_bound_pool_or_the_default() {
    let pools = parse_value(&two_pools()).unwrap();
    assert_eq!(pools.resolve(Some("org_partner_a")).id(), "partner");
    assert_eq!(pools.resolve(Some("org_partner_b")).id(), "partner");
    // Another organization of the same account, a personal one, gets the
    // default pool: pools follow organizations, not accounts.
    assert_eq!(
        pools.resolve(Some("org_personal_of_same_account")).id(),
        "shared"
    );
    assert_eq!(pools.resolve(None).id(), "shared");
    // Runs queued before pools existed belong to the default pool.
    assert!(pools.route_names(pools.default_pool(), None));
    assert!(!pools.route_names(pools.by_id("partner").unwrap(), None));
    assert!(pools.route_names(pools.by_id("partner").unwrap(), Some("partner")));
}

#[test]
fn api_keys_can_come_from_a_file() {
    let path =
        std::env::temp_dir().join(format!("kordi-pool-key-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, format!("{PARTNER_KEY}\n")).unwrap();
    let mut file = two_pools();
    let entry = &mut file["pools"][1]["systemAgent"];
    entry.as_object_mut().unwrap().remove("apiKeyEnv");
    entry["apiKeyFile"] = json!(path.to_str().unwrap());
    let pools = parse_value(&file);
    std::fs::remove_file(&path).unwrap();
    let pools = pools.unwrap();
    assert_eq!(
        pools
            .by_id("partner")
            .unwrap()
            .provider(Feature::SystemAgent)
            .auth()
            .api_key(),
        PARTNER_KEY
    );
}

type Edit = Box<dyn FnOnce(&mut Value)>;

fn error_for(edit: impl FnOnce(&mut Value)) -> String {
    let mut file = two_pools();
    edit(&mut file);
    parse_value(&file)
        .expect_err("invalid pool file")
        .to_string()
}

#[test]
fn invalid_files_fail_with_a_clear_message() {
    let cases: Vec<(Edit, &str)> = vec![
        (Box::new(|f| f["version"] = json!(2)), "version must be 1"),
        (Box::new(|f| f["pools"] = json!([])), "at least one pool"),
        (
            Box::new(|f| f["defaultPool"] = json!("missing")),
            "defaultPool \"missing\"",
        ),
        (
            Box::new(|f| f["pools"][1]["id"] = json!("shared")),
            "used twice",
        ),
        (
            Box::new(|f| f["pools"][0]["id"] = json!("bad id")),
            "pool id must be",
        ),
        (
            Box::new(|f| f["pools"][0]["organizations"] = json!(["org_partner_a"])),
            "bound to more than one pool",
        ),
        (
            Box::new(|f| f["pools"][0]["limit"] = json!({})),
            "unknown field `limit`",
        ),
        (
            Box::new(|f| f["pools"][0]["limits"]["systemAgentRunsPerDay"] = json!(1)),
            "unknown field `systemAgentRunsPerDay`",
        ),
        (
            Box::new(|f| f["pools"][0]["systemAgent"]["provider"] = json!("vertex-ai")),
            "pool \"shared\" systemAgent provider must be",
        ),
        (
            Box::new(|f| {
                f["pools"][0]["systemAgent"]["baseUrl"] = json!("http://gateway.example.test/v1")
            }),
            "baseUrl must be an https URL",
        ),
        (
            Box::new(|f| f["pools"][0]["systemAgent"]["model"] = json!("two words")),
            "model must be a model id",
        ),
        (
            Box::new(|f| f["pools"][0]["systemAgent"]["apiKeyEnv"] = json!("KORDI_UNSET_KEY")),
            "apiKeyEnv KORDI_UNSET_KEY is not set",
        ),
        (
            Box::new(|f| f["pools"][0]["systemAgent"]["apiKeyFile"] = json!("/nonexistent/key")),
            "exactly one of apiKeyEnv or apiKeyFile",
        ),
        (
            Box::new(|f| {
                f["pools"][0]["systemAgent"]["headers"] = json!({"Authorization": "Bearer x"})
            }),
            "may not set the authorization header",
        ),
        (
            Box::new(|f| {
                f["pools"][0]["systemAgent"]["headers"] = json!({"X-Title": "line\nbreak"})
            }),
            "header x-title needs a printable ASCII value",
        ),
        (
            Box::new(|f| f["pools"][0]["systemAgent"]["headers"] = json!({"bad name": "value"})),
            "header names must be HTTP tokens",
        ),
        (
            Box::new(|f| f["pools"][0]["limits"]["poolRunsPerDay"] = json!(-1)),
            "expected u64 at line",
        ),
    ];
    for (edit, expected) in cases {
        let message = error_for(edit);
        assert!(
            message.contains(expected),
            "expected {expected:?} in {message:?}"
        );
    }
}

#[test]
fn errors_never_echo_secrets() {
    // A key pasted where a variable name belongs is not repeated.
    let message = error_for(|f| {
        f["pools"][0]["systemAgent"]["apiKeyEnv"] = json!("pasted-synthetic-secret-value")
    });
    assert!(message.contains("apiKeyEnv must name an environment variable"));
    assert!(!message.contains("pasted-synthetic-secret-value"));
    // A type error would quote the value; only its position is shown.
    let message = error_for(|f| {
        f["pools"][0]["limits"]["poolRunsPerDay"] = json!("pasted-synthetic-secret-value")
    });
    assert!(!message.contains("pasted-synthetic-secret-value"), "{message}");
    // Debug output of a pool hides keys.
    let pools = parse_value(&two_pools()).unwrap();
    let debug = format!("{pools:?}");
    assert!(!debug.contains(SHARED_KEY) && !debug.contains(PARTNER_KEY));
    assert!(!pools.default_pool().summary().contains(SHARED_KEY));
}

#[test]
fn without_a_pool_file_one_unlimited_pool_reproduces_the_system_agent_provider() {
    let values = HashMap::from([
        ("KORDI_SYSTEM_AGENT_OPENAI_API_KEY", "synthetic-env-key"),
        ("KORDI_SYSTEM_AGENT_OPENAI_MODEL", "env-model"),
        (
            "KORDI_SYSTEM_AGENT_OPENAI_BASE_URL",
            "https://models.example.test/v1",
        ),
    ]);
    let config =
        PendingSystemAgentConfig::from_lookup(|key| values.get(key).map(|v| v.to_string()))
            .unwrap()
            .unwrap();
    let pools = &config.resource_pools;
    assert_eq!(pools.pools().len(), 1);
    let pool = pools.default_pool();
    assert_eq!(pool.id(), "default");
    assert_eq!(pool.limits(), &crate::resource_pools::PoolLimits::default());
    assert!(!pool.is_stopped());
    for feature in [Feature::SystemAgent, Feature::Grounding] {
        let auth = pool.provider(feature).auth();
        assert_eq!(auth.api_key(), "synthetic-env-key");
        assert_eq!(auth.model(), "env-model");
        assert_eq!(auth.base_url(), "https://models.example.test/v1");
        assert_eq!(auth.provider(), "openai");
        assert!(pool.provider(feature).headers().is_empty());
    }
    assert_eq!(pools.resolve(Some("org_any")).id(), "default");
}

#[test]
fn a_pool_file_supplies_the_system_agent_provider() {
    let pools = parse_value(&two_pools()).unwrap();
    // No KORDI_SYSTEM_AGENT_OPENAI_* settings at all.
    let config = PendingSystemAgentConfig::from_lookup_with_pools(|_| None, Some(pools))
        .unwrap()
        .expect("the System agent runs on the default pool");
    assert_eq!(config.provider_auth.model(), "vendor/synthetic-model");
    assert_eq!(config.provider_auth.api_key(), SHARED_KEY);
    assert_eq!(config.resource_pools.pools().len(), 2);
    // The switch still turns the System agent off.
    let off = PendingSystemAgentConfig::from_lookup_with_pools(
        |key| (key == "KORDI_SYSTEM_AGENT_ENABLED").then(|| "false".to_string()),
        Some(parse_value(&two_pools()).unwrap()),
    )
    .unwrap();
    assert!(off.is_none());
}

#[test]
fn the_example_pool_file_is_valid() {
    let text = include_str!("../../../../docs/development/resource-pools.example.json");
    let pools = parse(text, |key| {
        key.starts_with("KORDI_POOL_")
            .then(|| "synthetic-key".to_string())
    })
    .expect("the documented example parses");
    let default = pools.default_pool();
    assert_eq!(
        default.limits().system_agent_runs_per_conversation,
        Some(50)
    );
    assert_eq!(default.limits().grounding_runs_per_person, None);
    assert_eq!(pools.pools().len(), 2);
}
