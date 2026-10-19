//! Per-conversation serialization of agent-run ownership transitions.
//!
//! Admission, lease, stop, spawn and terminal publication read other runs of
//! the same parent session (queue order, one running turn per agent,
//! subsession sequence, stale-executor takeover) and then write. Each takes a
//! transaction-scoped advisory lock keyed by that parent session, so those
//! check-then-write steps cannot interleave inside one conversation while
//! unrelated conversations and accounts never wait on each other.
//!
//! Every run row's `session_id` is its parent session, including subsession
//! follow-ups and spawned children, and `cloud_agent_subsessions` stores the
//! same value as `parent_session_id`. Lock order is always this advisory lock
//! first, then run or subsession rows.

use std::time::{Duration, Instant};

use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgConnection;
use uuid::Uuid;

const KEY_PREFIX: &str = "kordi-agent-run-session:";
const SLOW_LOG_THRESHOLD: Duration = Duration::from_millis(250);

/// Block until this transaction holds the lock for `session_id`.
pub async fn lock_session(
    conn: &mut PgConnection,
    session_id: &str,
) -> Result<(), sqlx_core::Error> {
    let started = Instant::now();
    query("SELECT pg_advisory_xact_lock(hashtextextended($1||$2,0))")
        .bind(KEY_PREFIX)
        .bind(session_id)
        .execute(conn)
        .await?;
    log_lock_wait(None, started);
    Ok(())
}

/// Take the lock for `session_id` only if no other transaction holds it.
pub(crate) async fn try_lock_session(
    conn: &mut PgConnection,
    session_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (locked,): (bool,) =
        query_as("SELECT pg_try_advisory_xact_lock(hashtextextended($1||$2,0))")
            .bind(KEY_PREFIX)
            .bind(session_id)
            .fetch_one(conn)
            .await?;
    Ok(locked)
}

/// Lock the parent session of `run_id`. A missing run takes no lock; callers
/// re-read the run under the lock and treat it as gone.
pub(crate) async fn lock_run(
    conn: &mut PgConnection,
    run_id: &str,
) -> Result<(), sqlx_core::Error> {
    let started = Instant::now();
    query("SELECT pg_advisory_xact_lock(hashtextextended($2||session_id,0)) FROM cloud_agent_fallback_runs WHERE run_id=$1")
        .bind(run_id)
        .bind(KEY_PREFIX)
        .execute(conn)
        .await?;
    log_lock_wait(Some(run_id), started);
    Ok(())
}

/// Lock the parent session of a subsession. `fallback_parent` names the
/// parent for a subsession that is about to be created.
pub(crate) async fn lock_subsession(
    conn: &mut PgConnection,
    subsession_id: Uuid,
    fallback_parent: Option<&str>,
) -> Result<(), sqlx_core::Error> {
    let started = Instant::now();
    query("SELECT pg_advisory_xact_lock(hashtextextended($2||parent,0)) FROM (SELECT COALESCE((SELECT parent_session_id FROM cloud_agent_subsessions WHERE subsession_id=$1),$3) AS parent) p WHERE parent IS NOT NULL")
        .bind(subsession_id)
        .bind(KEY_PREFIX)
        .bind(fallback_parent)
        .execute(conn)
        .await?;
    log_lock_wait(None, started);
    Ok(())
}

// Timing lines carry the operation, run id and milliseconds, never request
// content or session ids. Only slow calls are logged unless
// `KORDI_AGENT_RUN_TIMING_LOG=1`.
fn log_lock_wait(run_id: Option<&str>, started: Instant) {
    let wait = started.elapsed();
    if wait >= SLOW_LOG_THRESHOLD || verbose() {
        eprintln!(
            "[agent_run_timing] op=session_lock run={} wait_ms={}",
            run_id.unwrap_or("-"),
            wait.as_millis()
        );
    }
}

/// Run one ownership transition and log its wall-clock time.
pub(crate) async fn timed<T, E>(
    op: &'static str,
    run_id: Option<&str>,
    work: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let started = Instant::now();
    let result = work.await;
    log_op(
        op,
        run_id,
        if result.is_ok() { "ok" } else { "error" },
        started,
    );
    result
}

pub(crate) fn log_op(op: &str, run_id: Option<&str>, outcome: &str, started: Instant) {
    let total = started.elapsed();
    if total >= SLOW_LOG_THRESHOLD || verbose() {
        eprintln!(
            "[agent_run_timing] op={op} run={} outcome={outcome} total_ms={}",
            run_id.unwrap_or("-"),
            total.as_millis()
        );
    }
}

fn verbose() -> bool {
    std::env::var("KORDI_AGENT_RUN_TIMING_LOG").is_ok_and(|value| value == "1")
}
