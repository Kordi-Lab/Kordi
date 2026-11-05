use std::collections::BTreeMap;

use super::*;

pub(crate) fn test_provider(model: &str) -> PoolProvider {
    PoolProvider::new(
        SystemAgentProviderAuth::openai_api_key("synthetic-key", model).expect("synthetic key"),
    )
}

/// A default pool through a gateway with attribution headers, a pool bound to
/// one organization, and a stopped pool bound to another.
pub(crate) fn sample_pools(limits: PoolLimits) -> ResourcePools {
    let headers = BTreeMap::from([
        (
            "http-referer".to_string(),
            "https://app.example.test".to_string(),
        ),
        ("x-title".to_string(), "Example".to_string()),
    ]);
    let shared = ResourcePool::new(
        "shared",
        PoolProvider::new(
            SystemAgentProviderAuth::openai_api_key("synthetic-shared-key", "vendor/shared-model")
                .unwrap()
                .with_base_url("https://gateway.example.test/api/v1")
                .with_provider_id("openrouter"),
        )
        .with_headers(headers),
    )
    .with_limits(limits);
    let partner = ResourcePool::new(
        "partner",
        PoolProvider::new(
            SystemAgentProviderAuth::openai_api_key("synthetic-partner-key", "partner-model")
                .unwrap()
                .with_base_url("https://models.example.test/v1"),
        ),
    )
    .with_grounding(test_provider("partner-grounding-model"));
    let halted = ResourcePool::new("halted", test_provider("halted-model")).stopped(true);
    ResourcePools::new(
        vec![shared, partner, halted],
        "shared",
        [
            ("org_partner".to_string(), "partner".to_string()),
            ("org_halted".to_string(), "halted".to_string()),
        ],
    )
    .unwrap()
}

#[test]
fn two_organizations_of_one_account_can_use_different_pools() {
    let pools = sample_pools(PoolLimits::default());
    // An account's personal organization is not bound; its team is.
    assert_eq!(pools.resolve(Some("org_personal")).id(), "shared");
    assert_eq!(pools.resolve(Some("org_partner")).id(), "partner");
    assert_eq!(pools.resolve(None).id(), "shared");
    assert!(pools.resolve(Some("org_halted")).is_stopped());
}

#[test]
fn routes_name_the_pool_and_its_provider() {
    let pools = sample_pools(PoolLimits::default());
    let partner = pools.by_id("partner").unwrap();
    assert_eq!(
        partner.routing(Feature::Grounding)["defaultModel"],
        "partner-grounding-model"
    );
    assert_eq!(
        partner.routing(Feature::SystemAgent)["defaultModel"],
        "partner-model"
    );
    assert_eq!(
        partner.routing(Feature::Grounding)[ROUTE_POOL_FIELD],
        "partner"
    );
    let shared = pools.default_pool().routing(Feature::Grounding);
    assert_eq!(shared["defaultAuthProvider"], "openrouter");
    assert_eq!(shared["defaultModel"], "vendor/shared-model");
}

#[test]
fn pool_sets_reject_ambiguous_bindings() {
    let pool = |id: &str| ResourcePool::new(id, test_provider("model"));
    assert!(ResourcePools::new(vec![pool("a"), pool("a")], "a", []).is_err());
    assert!(ResourcePools::new(vec![pool("a")], "b", []).is_err());
    assert!(ResourcePools::new(
        vec![pool("a"), pool("b")],
        "a",
        [
            ("org".to_string(), "a".to_string()),
            ("org".to_string(), "b".to_string())
        ],
    )
    .is_err());
    assert!(
        ResourcePools::new(vec![pool("a")], "a", [("org".to_string(), "c".to_string())]).is_err()
    );
}

#[test]
fn summaries_show_limits_without_providers() {
    let pools = sample_pools(PoolLimits {
        system_agent_runs_per_conversation: Some(3),
        ..PoolLimits::default()
    });
    let summary = pools.default_pool().summary();
    assert!(
        summary.contains("system agent 3/conversation/day"),
        "{summary}"
    );
    assert!(
        summary.contains("grounding unlimited/person/day"),
        "{summary}"
    );
    assert!(!summary.contains("synthetic-shared-key") && !summary.contains("gateway"));
    assert!(pools
        .by_id("halted")
        .unwrap()
        .summary()
        .contains("(stopped)"));
}
