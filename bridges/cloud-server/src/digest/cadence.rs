//! How often a digest may run (issue 1869). Automatic runs, from the
//! background worker or from opening the digest, stay within hourly and
//! daily caps; pressing refresh is never capped. Every run is still the only
//! one in flight for its account.

use super::changes::{
    AUTOMATIC_RUNS_PER_DAY, AUTOMATIC_RUNS_PER_HOUR, OPEN_REFRESH_MINUTES,
    SOURCES_CHANGED_RETRY_MINUTES, TRIAGE_RUNS_PER_HOUR, URGENT_RUNS_PER_HOUR,
};
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;
use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Why a digest run starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// The background worker or opening the digest: capped, and only for
    /// changes that can matter to the digest.
    Automatic,
    /// A message the quick check found urgent: capped separately, so a few
    /// urgent updates still fit after the automatic runs of the hour.
    Urgent,
    /// The refresh button, or a retry with another provider account.
    Manual,
    /// The owner asked to rebuild the digest from its whole input.
    Full,
    /// The quick urgency check itself.
    Triage,
}

impl Trigger {
    fn label(self) -> &'static str {
        match self {
            Trigger::Automatic => "automatic",
            Trigger::Urgent => "urgent",
            Trigger::Manual => "manual",
            Trigger::Full => "full",
            Trigger::Triage => "triage",
        }
    }

    /// Whether the owner asked for this run, which bypasses the caps.
    pub fn requested(self) -> bool {
        matches!(self, Trigger::Manual | Trigger::Full)
    }
}

/// Whether another run of this kind fits within the caps. Automatic and
/// urgent runs share the daily cap; within an hour, automatic runs stop at
/// [`AUTOMATIC_RUNS_PER_HOUR`] and urgent ones at [`URGENT_RUNS_PER_HOUR`]
/// runs in total. Quick checks have their own hourly cap. When a run does not
/// fit, the digest stays marked and the worker looks again in a few minutes.
pub async fn within_caps(pool: &PgPool, account: &str, trigger: Trigger) -> Result<bool> {
    if trigger.requested() {
        return Ok(true);
    }
    let (hour, day, checks): (i64, i64, i64) = query_as(
        "SELECT COUNT(*) FILTER (WHERE run_trigger<>'triage' AND created_at > now() - interval '1 hour'),
                COUNT(*) FILTER (WHERE run_trigger<>'triage'),
                COUNT(*) FILTER (WHERE run_trigger='triage' AND created_at > now() - interval '1 hour')
         FROM cloud_digest_runs
         WHERE account_id=$1 AND run_trigger IN ('automatic','urgent','triage')
           AND created_at > now() - interval '1 day'",
    )
    .bind(account)
    .fetch_one(pool)
    .await?;
    let fits = match trigger {
        Trigger::Triage => return Ok(checks < TRIAGE_RUNS_PER_HOUR),
        Trigger::Urgent => hour < URGENT_RUNS_PER_HOUR,
        _ => hour < AUTOMATIC_RUNS_PER_HOUR,
    } && day < AUTOMATIC_RUNS_PER_DAY;
    if fits {
        return Ok(true);
    }
    query(
        "UPDATE cloud_account_digests
         SET retry_after=GREATEST(retry_after, now() + interval '5 minutes')
         WHERE account_id=$1",
    )
    .bind(account)
    .execute(pool)
    .await?;
    Ok(false)
}

/// Records a run as it is queued, in the queuing transaction, with the model
/// and thinking level it asks for.
pub async fn record(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    account: &str,
    run: &str,
    trigger: Trigger,
    route: &AgentRuntimeRoute,
) -> Result<()> {
    query("DELETE FROM cloud_digest_runs WHERE account_id=$1 AND created_at < now() - interval '2 days'")
        .bind(account)
        .execute(&mut **tx)
        .await?;
    query("INSERT INTO cloud_digest_runs(run_id,account_id,run_trigger,model,thinking) VALUES($1,$2,$3,$4,$5)")
        .bind(run)
        .bind(account)
        .bind(trigger.label())
        .bind(&route.default_model)
        .bind(&route.thinking)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Whether opening the digest now starts a run, claimed at most once per
/// interval: a first build that was never attempted, or a snapshot older than
/// the interval with changes pending. Polling the open digest cannot start
/// more runs, since the claim holds for the whole interval.
pub async fn claim_open_refresh(pool: &PgPool, account: &str) -> Result<bool> {
    let claimed: Option<(String,)> = query_as(
        "UPDATE cloud_account_digests SET opened_run_at=now()
         WHERE account_id=$1 AND active_run_id IS NULL AND retry_after<=now()
           AND (opened_run_at IS NULL OR opened_run_at <= now() - make_interval(mins => $2))
           AND ((snapshot_json IS NULL AND error_code IS NULL)
             OR (dirty_since IS NOT NULL AND updated_at <= now() - make_interval(mins => $2)))
         RETURNING account_id",
    )
    .bind(account)
    .bind(OPEN_REFRESH_MINUTES as i32)
    .fetch_optional(pool)
    .await?;
    Ok(claimed.is_some())
}

pub async fn fail(pool: &PgPool, run: &str, runner: Option<&str>, code: &str) -> Result<()> {
    let mut tx = pool.begin().await?;
    let changed=query("UPDATE cloud_agent_fallback_runs SET status='failed',error_code=$3,error_message='Digest update failed.',updated_at=$4 WHERE run_id=$1 AND ($2::text IS NULL OR claimed_by=$2) AND status IN ('queued','leased','running')").bind(run).bind(runner).bind(code).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    let mut retry_now = None;
    if changed.rows_affected() > 0 && super::urgent::is_triage(&mut tx, run).await? {
        // A failed quick check only frees the digest for its next run.
        query("UPDATE cloud_account_digests SET active_run_id=NULL WHERE active_run_id=$1")
            .bind(run)
            .execute(&mut *tx)
            .await?;
    } else if changed.rows_affected() > 0 {
        // When the failure may be the account's, the digest retries at once
        // with the owner's next account (see `fallback`).
        let switched = super::fallback::switches_account(&mut tx, pool, run, code).await?;
        // Repeated failures back off (1 minute, 5 minutes, 30 minutes, 2 hours,
        // then 12 hours) so a broken provider sign-in costs a handful of calls
        // a day. A source change is not a failure: the digest stays marked
        // and retries after a short wait, within the caps on automatic runs.
        retry_now = query_as::<_, (String,)>(
            "UPDATE cloud_account_digests SET active_run_id=NULL,error_code=$2,input_hash='',
                failure_count=CASE WHEN $2='sources_changed' OR $3 THEN failure_count ELSE failure_count+1 END,
                dirty_since=CASE WHEN $2='sources_changed' THEN COALESCE(dirty_since, now()) ELSE dirty_since END,
                last_change_at=CASE WHEN $2='sources_changed' THEN COALESCE(last_change_at, now()) ELSE last_change_at END,
                retry_after=now()+CASE
                    WHEN $3 THEN interval '0 seconds'
                    WHEN $2='sources_changed' THEN make_interval(mins => $4)
                    WHEN failure_count=0 THEN interval '1 minute'
                    WHEN failure_count=1 THEN interval '5 minutes'
                    WHEN failure_count=2 THEN interval '30 minutes'
                    WHEN failure_count=3 THEN interval '2 hours'
                    ELSE interval '12 hours' END
             WHERE active_run_id=$1 RETURNING account_id",
        )
        .bind(run)
        .bind(code)
        .bind(switched)
        .bind(SOURCES_CHANGED_RETRY_MINUTES as i32)
        .fetch_optional(&mut *tx)
        .await?
        .filter(|_| switched);
    }
    tx.commit().await?;
    if let Some((account,)) = retry_now {
        super::store::refresh(pool, &account).await?;
    }
    Ok(())
}
