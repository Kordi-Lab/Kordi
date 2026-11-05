//! Reloading pools without a restart.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::*;
use crate::resource_pools::Executor;

fn env(key: &str) -> Option<String> {
    (key == "KORDI_POOL_TEST_KEY").then(|| "synthetic-test-pool-key".to_string())
}

fn pool_file(stopped: bool, model: &str) -> Value {
    pool_file_with_key(stopped, model, json!({"apiKeyEnv": "KORDI_POOL_TEST_KEY"}))
}

fn pool_file_with_key(stopped: bool, model: &str, key: Value) -> Value {
    let mut system_agent = json!({"baseUrl": "https://models.example.test/v1", "model": model});
    for (name, value) in key.as_object().into_iter().flatten() {
        system_agent[name] = value.clone();
    }
    json!({
        "version": 2,
        "defaultPool": "shared",
        "pools": [
            {
                "id": "shared",
                "executor": "control_plane",
                "systemAgent": system_agent
            },
            {
                "id": "partner",
                "executor": "pool_worker",
                "worker": {"identity": {
                    "issuer": "https://issuer.example.test",
                    "audience": "https://control.example.test",
                    "subject": "partner-worker"
                }},
                "stopped": stopped
            }
        ]
    })
}

/// A file in a fresh temporary directory, removed when dropped.
struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("kordi-pools-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir.join(name))
    }

    fn write(&self, value: &str) {
        std::fs::write(&self.0, value).unwrap();
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn offline_db() -> sqlx_postgres::PgPool {
    sqlx_postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://127.0.0.1:1/unused")
        .unwrap()
}

fn registry_for(file: &TempFile, organizations: Option<&TempFile>) -> ResourcePoolRegistry {
    let pools = config::load_file(&file.path(), env).unwrap();
    ResourcePoolRegistry::with_sources(pools, Some(file.path()), organizations.map(TempFile::path))
}

#[tokio::test]
async fn a_valid_change_is_swapped_in_and_old_snapshots_stay_whole() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "first-model").to_string());
    let registry = registry_for(&file, None);
    let before = registry.current();
    assert!(!registry.changed());

    file.write(&pool_file(false, "second-model").to_string());
    assert!(registry.changed());
    registry.reload_with(&offline_db(), env).await.unwrap();
    assert!(!registry.changed());
    let model = |pools: &ResourcePools| {
        pools
            .default_pool()
            .provider(crate::resource_pools::Feature::SystemAgent)
            .unwrap()
            .auth()
            .model()
            .to_string()
    };
    assert_eq!(model(&registry.current()), "second-model");
    // A reader holding the old snapshot keeps a consistent view.
    assert_eq!(model(&before), "first-model");
    // Clones share the live set.
    assert_eq!(model(&registry.clone().current()), "second-model");
}

#[tokio::test]
async fn an_invalid_change_keeps_the_previous_pools() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "first-model").to_string());
    let registry = registry_for(&file, None);
    for broken in [
        "{ not json".to_string(),
        json!({"version": 2, "defaultPool": "missing", "pools": pool_file(false, "m")["pools"]})
            .to_string(),
        pool_file(false, "model with spaces").to_string(),
    ] {
        file.write(&broken);
        assert!(registry.reload_with(&offline_db(), env).await.is_err());
        let pools = registry.current();
        assert_eq!(pools.pools().len(), 2);
        assert_eq!(
            pools
                .default_pool()
                .provider(crate::resource_pools::Feature::SystemAgent)
                .unwrap()
                .auth()
                .model(),
            "first-model"
        );
    }
    // A missing key is refused too, so a reload never drops a pool's key.
    file.write(&pool_file(false, "first-model").to_string());
    assert!(registry.reload_with(&offline_db(), |_| None).await.is_err());
}

#[tokio::test]
async fn the_stop_switch_applies_on_reload() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let registry = registry_for(&file, None);
    assert!(!registry.current().by_id("partner").unwrap().is_stopped());
    file.write(&pool_file(true, "model").to_string());
    registry.reload_with(&offline_db(), env).await.unwrap();
    let partner = registry.current().by_id("partner").unwrap().clone();
    assert!(partner.is_stopped());
    assert_eq!(partner.executor(), Executor::PoolWorker);
    file.write(&pool_file(false, "model").to_string());
    registry.reload_with(&offline_db(), env).await.unwrap();
    assert!(!registry.current().by_id("partner").unwrap().is_stopped());
}

#[tokio::test]
async fn the_watcher_picks_up_a_stop_within_seconds() {
    // The watcher reads keys from the real environment, so this pool file
    // names a key file instead.
    let key = TempFile::new("key");
    key.write("synthetic-test-pool-key");
    let key_source = json!({"apiKeyFile": key.path()});
    let file = TempFile::new("pools.json");
    file.write(&pool_file_with_key(false, "model", key_source.clone()).to_string());
    let registry = registry_for(&file, None);
    let watcher = registry.clone().spawn_watcher(offline_db());
    file.write(&pool_file_with_key(true, "model", key_source).to_string());
    let deadline = std::time::Instant::now() + WATCH_INTERVAL * 3;
    while !registry.current().by_id("partner").unwrap().is_stopped() {
        assert!(
            std::time::Instant::now() < deadline,
            "the stop was not picked up"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    watcher.abort();
}

#[tokio::test]
async fn the_organizations_file_is_validated_against_the_pools() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let organizations = TempFile::new("organizations.json");
    let registry = registry_for(&file, Some(&organizations));
    // Unknown fields belong to admission and are ignored; a disabled
    // organization and one without a pool bind nothing.
    organizations.write(
        &json!({
            "version": 1,
            "personalOrganizations": {"pool": "shared"},
            "organizations": [
                {"id": "research-team", "state": "disabled", "pool": "partner", "admission": {}},
                {"id": "open-team", "state": "active", "pool": null}
            ]
        })
        .to_string(),
    );
    registry.reload_with(&offline_db(), env).await.unwrap();
    for (bad, expected) in [
        (
            json!({"organizations": [{"id": "team", "pool": "missing"}]}),
            "unknown pool",
        ),
        (
            json!({"personalOrganizations": {"pool": "partner"}}),
            "must be the defaultPool",
        ),
        (json!({"organizations": [{"id": "Upper"}]}), "lowercase"),
        (
            json!({"organizations": [{"id": "team"}, {"id": "team"}]}),
            "twice",
        ),
    ] {
        organizations.write(&bad.to_string());
        let Err(error) = registry.reload_with(&offline_db(), env).await else {
            panic!("{bad} was accepted");
        };
        assert!(error.to_string().contains(expected), "{error}");
    }
}

#[test]
fn organizations_file_bindings() {
    let bindings = organizations::parse(
        &json!({"organizations": [
            {"id": "team-a", "pool": "partner"},
            {"id": "team-b", "state": "interim", "pool": "shared"},
            {"id": "team-c", "state": "disabled", "pool": "partner"}
        ]})
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        bindings.organizations,
        vec![
            ("team-a".to_string(), "partner".to_string()),
            ("team-b".to_string(), "shared".to_string()),
        ]
    );
    assert!(organizations::parse("\"text\"").is_err());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn configured_organizations_bind_once_they_exist() {
    let db = crate::resource_pools::usage::tests::test_db().await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let config_id = format!("team-{}", &suffix[..12]);
    let disabled_id = format!("off-{}", &suffix[..12]);
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let organizations = TempFile::new("organizations.json");
    organizations.write(
        &json!({"organizations": [
            {"id": config_id, "state": "active", "pool": "partner"},
            {"id": disabled_id, "state": "disabled", "pool": null}
        ]})
        .to_string(),
    );
    let registry = registry_for(&file, Some(&organizations));
    // Admission from configuration adds this column. Without it the
    // bindings cannot be honoured, so the configuration is refused.
    let has_column: bool = sqlx_core::query_scalar::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'cloud_organizations' AND column_name = 'config_id')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    if !has_column {
        let error = registry.reload_with(&db, env).await.unwrap_err();
        assert!(error.to_string().contains("config_id"), "{error}");
    }
    sqlx_core::query::query(
        "ALTER TABLE cloud_organizations ADD COLUMN IF NOT EXISTS config_id TEXT",
    )
    .execute(&db)
    .await
    .unwrap();
    registry.reload_with(&db, env).await.unwrap();
    let organization_id = format!("org_test_{suffix}");
    assert_eq!(
        registry.current().resolve(Some(&organization_id)).id(),
        "shared"
    );
    assert_eq!(registry.lock_state().unresolved, 1);

    let owner = format!("owner-{suffix}");
    crate::plan_cards::tests::seed_account(&db, &owner).await;
    let disabled_organization = format!("org_test_off_{suffix}");
    for (organization, configured) in [
        (&organization_id, &config_id),
        (&disabled_organization, &disabled_id),
    ] {
        sqlx_core::query::query(
            "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id, config_id) \
             VALUES ($1, 'Example team', 'team', $2, $3)",
        )
        .bind(organization)
        .bind(&owner)
        .bind(configured)
        .execute(&db)
        .await
        .unwrap();
    }
    registry.reload_with(&db, env).await.unwrap();
    let pools = registry.current();
    assert_eq!(pools.resolve(Some(&organization_id)).id(), "partner");
    assert!(pools.admits(Some(&organization_id)));
    assert!(
        !pools.admits(Some(&disabled_organization)),
        "disabled work is refused"
    );
    assert_eq!(registry.lock_state().unresolved, 0);
}

#[tokio::test]
async fn a_lookup_outage_still_applies_a_stop_and_keeps_bindings() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let organizations = TempFile::new("organizations.json");
    organizations.write(
        &json!({"organizations": [{"id": "team-a", "state": "active", "pool": "partner"}]})
            .to_string(),
    );
    let registry = registry_for(&file, Some(&organizations));
    // Bindings found before the database went away.
    registry.lock_state().found = vec![("team-a".to_string(), "org_team_a".to_string())];
    file.write(&pool_file(true, "model").to_string());
    // The database cannot be reached: the stop applies anyway, the earlier
    // binding stays, and the lookup is retried on the next check.
    let pools = registry.reload_with(&offline_db(), env).await.unwrap();
    assert!(pools.by_id("partner").unwrap().is_stopped());
    assert_eq!(pools.resolve(Some("org_team_a")).id(), "partner");
    assert!(registry.lock_state().lookup_failed);
    assert!(
        registry.due(false, 1),
        "a failed lookup is retried on every check"
    );
}

#[tokio::test]
async fn a_half_written_file_is_read_again_once_complete() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let registry = registry_for(&file, None);
    let full = pool_file(true, "model").to_string();
    file.write(&full[..full.len() / 2]);
    assert!(registry.reload_with(&offline_db(), env).await.is_err());
    // The broken state counts as seen, so it is reported once.
    assert!(!registry.due(false, 1));
    assert!(!registry.current().by_id("partner").unwrap().is_stopped());
    file.write(&full);
    assert!(registry.due(false, 1), "the finished write is noticed");
    registry.reload_with(&offline_db(), env).await.unwrap();
    assert!(registry.current().by_id("partner").unwrap().is_stopped());
}

#[test]
fn two_pools_cannot_accept_the_same_worker() {
    let mut value = pool_file(false, "model");
    let mut twin = value["pools"][1].clone();
    twin["id"] = json!("twin");
    value["pools"].as_array_mut().unwrap().push(twin);
    let error = config::parse(&value.to_string(), env).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("accept the same worker identity"),
        "{error}"
    );
}

#[tokio::test]
async fn covering_follows_the_organizations_file_across_reloads() {
    let file = TempFile::new("pools.json");
    file.write(&pool_file(false, "model").to_string());
    let organizations = TempFile::new("organizations.json");
    let write = |covers: Value| {
        organizations.write(
            &json!({"organizations": [
                {"id": "team-a", "state": "active", "pool": "partner", "coversMembersPersonalWork": covers},
                {"id": "team-b", "state": "disabled", "pool": "partner", "coversMembersPersonalWork": true}
            ]})
            .to_string(),
        )
    };
    write(json!(true));
    let registry = registry_for(&file, Some(&organizations));
    registry.lock_state().found = vec![
        ("team-a".to_string(), "org_team_a".to_string()),
        ("team-b".to_string(), "org_team_b".to_string()),
    ];
    registry.worker_sightings().note("partner");
    let pools = registry.reload_with(&offline_db(), env).await.unwrap();
    // A disabled organization covers nobody.
    assert_eq!(
        pools.covering_organizations(),
        vec!["org_team_a".to_string()]
    );
    write(json!(false));
    let pools = registry.reload_with(&offline_db(), env).await.unwrap();
    assert!(pools.covering_organizations().is_empty());
    assert!(
        registry
            .worker_sightings()
            .seen_within("partner", super::super::coverage::WORKER_SEEN_WINDOW),
        "worker sightings survive a reload"
    );
    // Covering needs a pool to cover with.
    let error = organizations::parse(
        &json!({"organizations": [{"id": "team-c", "pool": null, "coversMembersPersonalWork": true}]})
            .to_string(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("without a pool"), "{error}");
}
