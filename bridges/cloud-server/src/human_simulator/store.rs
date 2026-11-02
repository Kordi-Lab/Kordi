//! Durable simulator state with database-clock leases and generation fencing.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx_core::{error::Error, query::query, row::Row};
use sqlx_postgres::{PgPool, PgRow};

#[derive(Debug, Clone)]
pub struct ActorRecord {
    pub actor_id: String,
    pub config: Value,
    pub state: Value,
    pub revision: i64,
    pub generation: i64,
    pub model_calls: i32,
    pub messages_sent: i32,
    pub owner: Option<String>,
    pub lease_until: Option<DateTime<Utc>>,
}

const COLUMNS: &str =
    "actor_id, config, state, revision, generation, model_calls, messages_sent, owner, lease_until";

fn decode(row: PgRow) -> Result<ActorRecord, Error> {
    let config: String = row.try_get("config")?;
    let state: String = row.try_get("state")?;
    Ok(ActorRecord {
        actor_id: row.try_get("actor_id")?,
        config: serde_json::from_str(&config).map_err(|err| Error::Decode(Box::new(err)))?,
        state: serde_json::from_str(&state).map_err(|err| Error::Decode(Box::new(err)))?,
        revision: row.try_get("revision")?,
        generation: row.try_get("generation")?,
        model_calls: row.try_get("model_calls")?,
        messages_sent: row.try_get("messages_sent")?,
        owner: row.try_get("owner")?,
        lease_until: row.try_get("lease_until")?,
    })
}

pub async fn initialize(pool: &PgPool) -> Result<(), Error> {
    sqlx_core::raw_sql::raw_sql(include_str!("schema.sql"))
        .execute(pool)
        .await?;
    Ok(())
}

/// Only a SHA-256 digest of the actor bearer token may be passed here.
pub async fn create(
    pool: &PgPool,
    actor_id: &str,
    config: &Value,
    state: &Value,
    token_hash: &str,
) -> Result<bool, Error> {
    let config = config.to_string();
    let fingerprint = hex::encode(Sha256::digest(config.as_bytes()));
    Ok(query("INSERT INTO human_simulator_actors (actor_id, config, config_fingerprint, state, token_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (actor_id) DO NOTHING")
        .bind(actor_id).bind(config).bind(fingerprint).bind(state.to_string()).bind(token_hash)
        .execute(pool).await?.rows_affected() == 1)
}

pub async fn authorized(pool: &PgPool, actor_id: &str, token_hash: &str) -> Result<bool, Error> {
    let row = query("SELECT EXISTS(SELECT 1 FROM human_simulator_actors WHERE actor_id=$1 AND token_hash=$2) AS authorized")
        .bind(actor_id).bind(token_hash).fetch_one(pool).await?;
    row.try_get("authorized")
}

pub async fn get(pool: &PgPool, actor_id: &str) -> Result<Option<ActorRecord>, Error> {
    query(&format!(
        "SELECT {COLUMNS} FROM human_simulator_actors WHERE actor_id=$1"
    ))
    .bind(actor_id)
    .fetch_optional(pool)
    .await?
    .map(decode)
    .transpose()
}

/// Reacquiring an expired lease fences every operation from the old generation,
/// including operations from the same worker identity.
pub async fn lease(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
) -> Result<Option<ActorRecord>, Error> {
    query(&format!("UPDATE human_simulator_actors SET generation=CASE WHEN owner=$2 AND lease_until>statement_timestamp() THEN generation ELSE generation+1 END, owner=$2, lease_until=statement_timestamp()+INTERVAL '60 seconds' WHERE actor_id=$1 AND (owner=$2 OR lease_until IS NULL OR lease_until<=statement_timestamp()) AND COALESCE(state::jsonb->>'status', '') NOT IN ('stopped', 'finished') RETURNING {COLUMNS}"))
        .bind(actor_id).bind(owner).fetch_optional(pool).await?.map(decode).transpose()
}

pub async fn heartbeat(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
    generation: i64,
) -> Result<bool, Error> {
    Ok(query("UPDATE human_simulator_actors SET lease_until=statement_timestamp()+INTERVAL '60 seconds' WHERE actor_id=$1 AND owner=$2 AND generation=$3 AND lease_until>statement_timestamp() AND COALESCE(state::jsonb->>'status', '') NOT IN ('stopped', 'finished')")
        .bind(actor_id).bind(owner).bind(generation).execute(pool).await?.rows_affected() == 1)
}

pub async fn save(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
    generation: i64,
    expected_revision: i64,
    state: &Value,
) -> Result<bool, Error> {
    Ok(query("UPDATE human_simulator_actors SET state=$5, revision=revision+1 WHERE actor_id=$1 AND owner=$2 AND generation=$3 AND revision=$4 AND lease_until>statement_timestamp() AND COALESCE(state::jsonb->>'status', '') NOT IN ('stopped', 'finished')")
        .bind(actor_id).bind(owner).bind(generation).bind(expected_revision).bind(state.to_string())
        .execute(pool).await?.rows_affected() == 1)
}

/// Reserve a model attempt before making the external request. Failed attempts
/// deliberately consume budget so restart/retry loops cannot evade the limit.
pub async fn reserve_model(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
    generation: i64,
    expected_revision: i64,
    max_calls: i32,
) -> Result<Option<ActorRecord>, Error> {
    query(&format!("UPDATE human_simulator_actors SET model_calls=model_calls+1, revision=revision+1 WHERE actor_id=$1 AND owner=$2 AND generation=$3 AND revision=$4 AND lease_until>statement_timestamp() AND COALESCE(state::jsonb->>'status', '') NOT IN ('stopped', 'finished') AND model_calls<$5 RETURNING {COLUMNS}"))
        .bind(actor_id).bind(owner).bind(generation).bind(expected_revision).bind(max_calls)
        .fetch_optional(pool).await?.map(decode).transpose()
}

/// Commit a confirmed delivery and its new state in one compare-and-swap.
#[allow(clippy::too_many_arguments)]
pub async fn confirm_message(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
    generation: i64,
    expected_revision: i64,
    state: &Value,
    max_messages: i32,
) -> Result<bool, Error> {
    Ok(query("UPDATE human_simulator_actors SET messages_sent=messages_sent+1, state=$6, revision=revision+1 WHERE actor_id=$1 AND owner=$2 AND generation=$3 AND revision=$4 AND lease_until>statement_timestamp() AND COALESCE(state::jsonb->>'status', '') NOT IN ('stopped', 'finished') AND messages_sent<$5")
        .bind(actor_id).bind(owner).bind(generation).bind(expected_revision).bind(max_messages).bind(state.to_string())
        .execute(pool).await?.rows_affected() == 1)
}

pub async fn release(
    pool: &PgPool,
    actor_id: &str,
    owner: &str,
    generation: i64,
) -> Result<bool, Error> {
    Ok(query("UPDATE human_simulator_actors SET owner=NULL, lease_until=statement_timestamp() WHERE actor_id=$1 AND owner=$2 AND generation=$3")
        .bind(actor_id).bind(owner).bind(generation).execute(pool).await?.rows_affected() == 1)
}

/// Operator stop does not require the worker lease and invalidates in-flight work.
pub async fn stop(pool: &PgPool, actor_id: &str) -> Result<bool, Error> {
    Ok(query("UPDATE human_simulator_actors SET state=(CASE WHEN jsonb_typeof(state::jsonb)='object' THEN jsonb_set(state::jsonb, '{status}', '\"stopped\"'::jsonb) ELSE '{\"status\":\"stopped\"}'::jsonb END)::text, revision=revision+1, generation=generation+1, owner=NULL, lease_until=statement_timestamp() WHERE actor_id=$1")
        .bind(actor_id).execute(pool).await?.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use serde_json::json;
    use sqlx_postgres::PgPoolOptions;
    use std::panic::AssertUnwindSafe;

    // This test never falls back to DATABASE_URL or the shared development DB.
    // The caller must explicitly supply a disposable, isolated Postgres database.
    #[tokio::test]
    #[ignore = "requires task-owned PostgreSQL"]
    async fn isolated_postgres_fences_workers_and_enforces_budgets() {
        let url = std::env::var("KORDI_SIM_TEST_DATABASE_URL")
            .expect("set explicit isolated database URL");
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .expect("connect to explicitly selected isolated simulator test database");
        initialize(&pool).await.unwrap();
        let actor = format!("store-test-{}", uuid::Uuid::new_v4());
        let result = AssertUnwindSafe(exercise(&pool, &actor))
            .catch_unwind()
            .await;
        query("DELETE FROM human_simulator_actors WHERE actor_id=$1")
            .bind(&actor)
            .execute(&pool)
            .await
            .unwrap();
        match result {
            Ok(result) => result.unwrap(),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn exercise(pool: &PgPool, actor: &str) -> Result<(), Error> {
        let running = json!({"status": "running"});
        let token_hash = hex::encode(Sha256::digest(b"synthetic-test-token"));
        assert!(create(pool, actor, &json!({"test": true}), &running, &token_hash).await?);
        assert!(!create(pool, actor, &json!({}), &running, &token_hash).await?);
        assert!(authorized(pool, actor, &token_hash).await?);
        assert!(!authorized(pool, actor, "wrong-hash").await?);
        let first = lease(pool, actor, "worker-a").await?.unwrap();
        assert!(lease(pool, actor, "worker-b").await?.is_none());
        let renewed = lease(pool, actor, "worker-a").await?.unwrap();
        assert_eq!(first.generation, renewed.generation);
        assert!(heartbeat(pool, actor, "worker-a", first.generation).await?);
        assert!(!save(pool, actor, "worker-b", first.generation, 0, &running).await?);
        let reserved = reserve_model(pool, actor, "worker-a", first.generation, 0, 1)
            .await?
            .unwrap();
        assert_eq!(reserved.model_calls, 1);
        assert_eq!(reserved.revision, 1);
        assert!(
            reserve_model(pool, actor, "worker-a", first.generation, 1, 1)
                .await?
                .is_none()
        );
        assert!(!save(pool, actor, "worker-a", first.generation, 0, &running).await?);
        assert!(confirm_message(pool, actor, "worker-a", first.generation, 1, &running, 1).await?);
        assert!(!confirm_message(pool, actor, "worker-a", first.generation, 2, &running, 1).await?);
        assert!(release(pool, actor, "worker-a", first.generation).await?);
        let second = lease(pool, actor, "worker-b").await?.unwrap();
        assert!(second.generation > first.generation);
        assert!(!heartbeat(pool, actor, "worker-a", first.generation).await?);
        assert!(!save(pool, actor, "worker-a", first.generation, 2, &running).await?);
        assert!(stop(pool, actor).await?);
        assert!(!save(pool, actor, "worker-b", second.generation, 2, &running).await?);
        assert!(!heartbeat(pool, actor, "worker-b", second.generation).await?);
        assert!(lease(pool, actor, "worker-b").await?.is_none());
        let stopped = get(pool, actor).await?.unwrap();
        assert_eq!(stopped.state["status"], "stopped");
        assert_eq!(stopped.messages_sent, 1);
        assert_eq!(stopped.model_calls, 1);
        Ok(())
    }
}
