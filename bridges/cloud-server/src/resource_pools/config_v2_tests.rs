//! Format 2: executors, pool worker pools and their identities.

use serde_json::{json, Value};

use super::*;
use crate::resource_pools::{Executor, Feature};

const IDENTITY_ENV: &str = "KORDI_POOL_PARTNER_WORKER_IDENTITY";

fn identity() -> Value {
    json!({
        "issuer": "https://issuer.example.test",
        "audience": "https://control.example.test",
        "subject": "partner-worker",
    })
}

fn env(key: &str) -> Option<String> {
    match key {
        "KORDI_POOL_SHARED_KEY" => Some("synthetic-shared-pool-key".to_string()),
        IDENTITY_ENV => Some(identity().to_string()),
        _ => None,
    }
}

/// The shape the deployment configuration renders: a control plane default
/// pool and a pool worker pool with no provider and no key.
fn format_two() -> Value {
    json!({
        "version": 2,
        "defaultPool": "shared",
        "pools": [
            {
                "id": "shared",
                "executor": "control_plane",
                "systemAgent": {
                    "provider": "openrouter",
                    "baseUrl": "https://gateway.example.test/api/v1",
                    "model": "vendor/synthetic-model",
                    "apiKeyEnv": "KORDI_POOL_SHARED_KEY",
                    "estimatedCostMicrosPerRun": 1500
                },
                "limits": {"systemAgentRunsPerConversationPerDay": 50},
                "stopped": false
            },
            {
                "id": "partner",
                "executor": "pool_worker",
                "worker": {"identityEnv": IDENTITY_ENV},
                "estimatedCostMicrosPerRun": 4000,
                "limits": {
                    "systemAgentRunsPerConversationPerDay": "unlimited",
                    "groundingRunsPerPersonPerDay": "unlimited",
                    "poolRunsPerDay": 1000,
                    "poolSpendMicrosPerDay": 5000000
                },
                "stopped": false
            }
        ]
    })
}

fn parse_value(value: &Value) -> Result<ResourcePools, ResourcePoolConfigError> {
    parse(&value.to_string(), env)
}

fn error_of(value: &Value) -> String {
    parse_value(value).unwrap_err().to_string()
}

#[test]
fn format_two_reads_executors_and_worker_pools() {
    let pools = parse_value(&format_two()).unwrap();
    let shared = pools.by_id("shared").unwrap();
    assert_eq!(shared.executor(), Executor::ControlPlane);
    assert_eq!(shared.estimated_cost_micros(Feature::Grounding), 1500);
    let partner = pools.by_id("partner").unwrap();
    assert_eq!(partner.executor(), Executor::PoolWorker);
    // The control plane holds no provider, model or key for a worker pool.
    assert!(partner.provider(Feature::SystemAgent).is_none());
    assert!(partner.provider(Feature::Grounding).is_none());
    assert_eq!(partner.estimated_cost_micros(Feature::SystemAgent), 4000);
    let accepted = partner.worker_identity().unwrap();
    assert_eq!(accepted.subject.as_deref(), Some("partner-worker"));
    assert_eq!(accepted.audience, "https://control.example.test");
    assert_eq!(
        partner.routing(Feature::SystemAgent),
        json!({"resourcePool": "partner", "poolExecutor": "pool_worker"})
    );
    assert!(partner.summary().contains("(pool worker)"));
}

#[test]
fn format_one_files_load_unchanged_and_reject_format_two_fields() {
    let mut one = format_two();
    one["version"] = json!(1);
    assert!(error_of(&one).contains("need version 2"));
    let mut plain = format_two();
    plain["version"] = json!(1);
    plain["pools"][0]
        .as_object_mut()
        .unwrap()
        .remove("executor");
    plain["pools"].as_array_mut().unwrap().truncate(1);
    let pools = parse_value(&plain).unwrap();
    assert_eq!(pools.default_pool().executor(), Executor::ControlPlane);
    let mut three = format_two();
    three["version"] = json!(3);
    assert!(error_of(&three).contains("version must be 1 or 2"));
}

#[test]
fn worker_identity_inline_or_unset() {
    let mut inline = format_two();
    inline["pools"][1]["worker"] = json!({"identity": identity()});
    let pools = parse_value(&inline).unwrap();
    assert!(pools.by_id("partner").unwrap().worker_identity().is_some());
    // An unset identity variable accepts no worker; the pool still loads.
    let unset = parse(&format_two().to_string(), |key| {
        (key != IDENTITY_ENV).then(|| env(key)).flatten()
    })
    .unwrap();
    assert!(unset.by_id("partner").unwrap().worker_identity().is_none());
}

#[test]
fn format_two_errors_name_the_pool_and_field() {
    type Change = Box<dyn Fn(&mut Value)>;
    let cases: Vec<(Change, &str)> = vec![
        (
            Box::new(|v| {
                v["pools"][1].as_object_mut().unwrap().remove("executor");
            }),
            "executor is required",
        ),
        (
            Box::new(|v| v["pools"][1]["executor"] = json!("elsewhere")),
            "executor must be",
        ),
        (
            Box::new(|v| {
                v["pools"][1].as_object_mut().unwrap().remove("worker");
            }),
            "worker is required",
        ),
        (
            Box::new(|v| v["pools"][1]["worker"] = json!({})),
            "exactly one of identityEnv",
        ),
        (
            Box::new(|v| v["pools"][1]["worker"] = json!({"identityEnv": "lowercase"})),
            "must name an environment variable",
        ),
        (
            Box::new(|v| {
                v["pools"][1]["worker"] =
                    json!({"identity": {"issuer": "https://issuer.example.test", "audience": "a"}})
            }),
            "needs a subject or an email",
        ),
        (
            Box::new(
                |v| v["pools"][1]["worker"] = json!({"identity": {"issuer": "http://issuer.example.test", "audience": "a", "subject": "s"}}),
            ),
            "issuer must be an https URL",
        ),
        (
            Box::new(|v| v["pools"][1]["systemAgent"] = v["pools"][0]["systemAgent"].clone()),
            "may not name systemAgent",
        ),
        (
            Box::new(|v| {
                v["pools"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("estimatedCostMicrosPerRun");
            }),
            "poolSpendMicrosPerDay needs",
        ),
        (
            Box::new(|v| v["pools"][0]["worker"] = json!({"identity": identity()})),
            "only used with executor pool_worker",
        ),
        (
            Box::new(|v| v["defaultPool"] = json!("partner")),
            "must have executor control_plane",
        ),
    ];
    for (change, expected) in cases {
        let mut value = format_two();
        change(&mut value);
        let error = error_of(&value);
        assert!(
            error.contains(expected),
            "{error} should contain {expected}"
        );
    }
}

#[test]
fn an_invalid_identity_value_is_reported_without_its_contents() {
    let error = parse(&format_two().to_string(), |key| match key {
        IDENTITY_ENV => Some("not json at all".to_string()),
        other => env(other),
    })
    .unwrap_err()
    .to_string();
    assert!(error.contains(IDENTITY_ENV) && error.contains("must be JSON"));
    assert!(!error.contains("not json at all"));
}
