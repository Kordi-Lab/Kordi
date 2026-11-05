//! Usage pauses: when a limit refused the System agent in a conversation,
//! kept once per pool, conversation and window so Settings can show "Paused
//! since 14:20". Nothing is posted into the conversation.

use chrono::{DateTime, NaiveDate, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::snapshot::{Reached, Scope, UsageSnapshot};

/// A refused pass to record.
pub struct Pause<'a> {
    pub pool_id: &'a str,
    pub conversation_id: Uuid,
    pub organization_id: Option<&'a str>,
    /// The snapshot `limitId` of the limit that refused the pass.
    pub limit_id: &'a str,
    pub reached: Reached,
    pub now: DateTime<Utc>,
}

/// Records the pause in `tx`. The first refusal of a window is kept; later
/// ones change nothing. Returns whether this call recorded it.
pub async fn record(
    tx: &mut Transaction<'_, Postgres>,
    pause: &Pause<'_>,
) -> sqlx_core::Result<bool> {
    if pause.reached == Reached::None {
        return Ok(false);
    }
    let recorded = query(
        "INSERT INTO cloud_usage_pauses
             (pool_id, usage_day, conversation_id, organization_id, limit_id, reached, paused_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING",
    )
    .bind(pause.pool_id)
    .bind(pause.now.date_naive())
    .bind(pause.conversation_id.to_string())
    .bind(pause.organization_id)
    .bind(pause.limit_id)
    .bind(pause.reached.as_str())
    .bind(pause.now)
    .execute(&mut **tx)
    .await?;
    Ok(recorded.rows_affected() > 0)
}

/// One recorded pause: (conversation, limit id, reached, paused at).
type PauseRow = (String, String, String, DateTime<Utc>);

/// Fills `pausedSince` on every reached snapshot of `pool_id` from the
/// pauses recorded on `day`: the earliest pause by that limit (any pause by
/// the stop switch for a stopped pool), and for the per-conversation limit
/// only pauses in its own conversation. Unless `pool_wide`, only the
/// per-conversation limit gets one: in a pool shared with other
/// organizations, any other pause may come from one of their conversations.
pub async fn attach(
    db: &PgPool,
    pool_id: &str,
    day: NaiveDate,
    pool_wide: bool,
    snapshots: &mut [UsageSnapshot],
) -> sqlx_core::Result<()> {
    let shown = |s: &UsageSnapshot| pool_wide || s.scope == Scope::Conversation;
    if snapshots
        .iter()
        .all(|s| s.reached == Reached::None || !shown(s))
    {
        return Ok(());
    }
    let rows: Vec<PauseRow> = query_as(
        "SELECT conversation_id, limit_id, reached, paused_at FROM cloud_usage_pauses
         WHERE pool_id = $1 AND usage_day = $2
         ORDER BY paused_at",
    )
    .bind(pool_id)
    .bind(day)
    .fetch_all(db)
    .await?;
    for snapshot in snapshots.iter_mut().filter(|s| shown(s)) {
        snapshot.paused_since = paused_since(snapshot, &rows);
    }
    Ok(())
}

/// The earliest recorded pause that `snapshot` stands for, from `rows`
/// sorted by time.
pub fn paused_since(snapshot: &UsageSnapshot, rows: &[PauseRow]) -> Option<String> {
    if snapshot.reached == Reached::None {
        return None;
    }
    rows.iter()
        .find(|(conversation, limit_id, reached, _)| {
            let same_limit = if snapshot.reached == Reached::Stopped {
                reached == Reached::Stopped.as_str()
            } else {
                limit_id == snapshot.limit_id
            };
            let same_scope = snapshot.scope != Scope::Conversation
                || snapshot.conversation_id.as_deref() == Some(conversation.as_str());
            same_limit && same_scope
        })
        .map(|(_, _, _, at)| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn snapshot(limit_id: &'static str, scope: Scope, reached: Reached) -> UsageSnapshot {
        UsageSnapshot {
            limit_id,
            scope,
            conversation_id: (scope == Scope::Conversation).then(|| "chat-a".to_string()),
            used: None,
            limit: None,
            used_percent: 100,
            window: "day",
            resets_at: "2030-01-03T00:00:00Z".to_string(),
            reached,
            paused_since: None,
        }
    }

    fn row(conversation: &str, limit_id: &str, reached: Reached, hour: u32) -> PauseRow {
        (
            conversation.to_string(),
            limit_id.to_string(),
            reached.as_str().to_string(),
            Utc.with_ymd_and_hms(2030, 1, 2, hour, 20, 0).unwrap(),
        )
    }

    #[test]
    fn each_limit_shows_its_own_earliest_pause() {
        let rows = vec![
            row(
                "chat-b",
                "conversation.system_agent_runs",
                Reached::DailyLimit,
                9,
            ),
            row(
                "chat-a",
                "conversation.system_agent_runs",
                Reached::DailyLimit,
                11,
            ),
            row("chat-c", "pool.runs", Reached::DailyLimit, 14),
            row("chat-a", "pool.runs", Reached::DailyLimit, 15),
        ];
        let chat = snapshot(
            "conversation.system_agent_runs",
            Scope::Conversation,
            Reached::DailyLimit,
        );
        assert_eq!(
            paused_since(&chat, &rows).as_deref(),
            Some("2030-01-02T11:20:00Z")
        );
        let pool = snapshot("pool.runs", Scope::Pool, Reached::DailyLimit);
        assert_eq!(
            paused_since(&pool, &rows).as_deref(),
            Some("2030-01-02T14:20:00Z")
        );
        let spend = snapshot("pool.spend", Scope::Pool, Reached::SpendLimit);
        assert_eq!(
            paused_since(&spend, &rows),
            None,
            "spend never refused a pass"
        );
        let open = snapshot("pool.runs", Scope::Pool, Reached::None);
        assert_eq!(
            paused_since(&open, &rows),
            None,
            "a limit not reached shows no pause"
        );
    }

    #[test]
    fn a_stopped_pool_shows_the_first_stop() {
        let rows = vec![
            row("chat-c", "pool.runs", Reached::DailyLimit, 8),
            row("chat-b", "pool.stopped", Reached::Stopped, 10),
        ];
        for limit_id in ["pool.runs", "pool.spend", "pool.stopped"] {
            let stopped = snapshot(limit_id, Scope::Pool, Reached::Stopped);
            assert_eq!(
                paused_since(&stopped, &rows).as_deref(),
                Some("2030-01-02T10:20:00Z")
            );
        }
    }
}
