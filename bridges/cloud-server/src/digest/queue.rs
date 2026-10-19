//! Queues one digest run: the full digest, an incremental update, or the
//! quick urgency check. Every kind holds the digest's single active run, so
//! at most one runs per account, and a ready owner Mac runs it first.

use super::cadence::Trigger;
use super::model_choice::{self, DIGEST_THINKING, TRIAGE_THINKING};
use super::models::Input;
use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Queues a run of `input`. A digest run records `hash` as the input it
/// covers and does not repeat an input already covered unless the owner
/// asked for a full rebuild. Returns whether a run was queued.
pub(super) async fn queue(
    pool: &PgPool,
    account: &str,
    input: &Input,
    hash: Option<&str>,
    trigger: Trigger,
) -> Result<bool> {
    // The run names the account it uses, so the runner resolves the same one
    // this check found even when the owner holds several saved accounts.
    let session = format!("digest:{account}");
    let Some(route) = super::fallback::route(pool, account, &session).await? else {
        if trigger == Trigger::Triage {
            return Ok(false);
        }
        // Saved accounts that all need reconnecting are a sign-in problem, not a missing provider.
        let (live,):(i64,)=query_as("SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id=$1 AND revoked_at IS NULL").bind(account).fetch_one(pool).await?;
        let code = if live > 0 {
            "provider_auth_rejected"
        } else {
            "missing_provider_auth"
        };
        query("UPDATE cloud_account_digests SET error_code=$2,retry_after=now()+interval '30 seconds' WHERE account_id=$1").bind(account).bind(code).execute(pool).await?;
        return Ok(false);
    };
    let (thinking, system_prompt) = if trigger == Trigger::Triage {
        (TRIAGE_THINKING, super::urgent::TRIAGE_SYSTEM_PROMPT)
    } else {
        (DIGEST_THINKING, super::SYSTEM_PROMPT)
    };
    let preference = model_choice::preference(pool, account).await?;
    let route = model_choice::digest_route(route, &preference, thinking);
    let mut tx = pool.begin().await?;
    let run = format!("{}{}", super::RUN_PREFIX, Uuid::new_v4().simple());
    let value = serde_json::to_value(input).unwrap();
    let changed = match hash {
        Some(hash) => query("UPDATE cloud_account_digests SET active_run_id=$2,input_hash=$3,input_json=$4,error_code=NULL WHERE account_id=$1 AND active_run_id IS NULL AND (input_hash<>$3 OR $5)")
            .bind(account).bind(&run).bind(hash).bind(&value).bind(trigger == Trigger::Full).execute(&mut *tx).await?,
        None => query("UPDATE cloud_account_digests SET active_run_id=$2,input_json=$3 WHERE account_id=$1 AND active_run_id IS NULL")
            .bind(account).bind(&run).bind(&value).execute(&mut *tx).await?,
    };
    if changed.rows_affected() == 0 {
        return Ok(false);
    }
    super::cadence::record(&mut tx, account, &run, trigger, &route).await?;
    let now = Utc::now().to_rfc3339();
    // Digest runs are background runs (read-only connector tools) whose
    // output only the owner reads.
    // A ready owner Mac runs the digest first; the cloud runner waits until
    // `desktop_preferred_until` and then runs it if no Mac claimed it.
    let preferred_until = super::desktop::preferred_until(pool, account).await?;
    query("INSERT INTO cloud_agent_fallback_runs (run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,system_prompt,runtime_route_json,created_at,updated_at,run_trigger,connector_audience,desktop_preferred_until) VALUES($1,$1,$1,$2,$3,$3,'queued',$4,$5,$6,$7,$7,'background','owner_private',$8)")
        .bind(&run).bind(&session).bind(account).bind(serde_json::to_string(input).unwrap()).bind(system_prompt).bind(serde_json::to_value(&route).unwrap()).bind(now).bind(preferred_until).execute(&mut *tx).await?;
    if preferred_until.is_some() {
        super::desktop::announce(&mut tx, account, &run).await?;
    }
    tx.commit().await?;
    Ok(true)
}
