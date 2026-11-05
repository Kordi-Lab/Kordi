//! Usage notices, each shown once per window: the line in a conversation
//! whose System agent pass a pool refused, and the notices to an
//! organization's owners at 75% and 90% of its pool's daily cap.
//!
//! Each notice is a row in `cloud_usage_notices` written with
//! `ON CONFLICT DO NOTHING`; only the writer that inserted the row posts or
//! sends it, so concurrent passes and server replicas never repeat it.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::snapshot::{self, Reached};
use super::ResourcePools;
use crate::chat_sync::models::SendMessageRequest;
use crate::common_ground::SYSTEM_NOTICE_KIND;
use crate::notifications::{PushNotificationService, UsageNoticePush};

/// Thresholds of a pool's daily cap that notify owners, highest first.
pub const THRESHOLDS: [u8; 2] = [90, 75];

const CONVERSATION: &str = "conversation";
const ORGANIZATION: &str = "organization";
const PAUSED: &str = "paused";

fn threshold_notice(threshold: u8) -> &'static str {
    if threshold >= 90 {
        "threshold_90"
    } else {
        "threshold_75"
    }
}

/// The paused line as stored. Clients add the role-aware rest: a link to the
/// usage page for owners, "Ask an owner to raise it." for members.
pub fn paused_text(reached: Reached, resets_at: DateTime<Utc>) -> String {
    match reached {
        Reached::Stopped => "Paused by an owner.".to_string(),
        _ => format!(
            "Daily limit reached. Resets at {} UTC.",
            resets_at.format("%H:%M")
        ),
    }
}

/// The System notice that says a conversation's System agent is paused.
/// `usageLimit` lets clients choose the copy for the viewer's role.
pub fn paused_message(
    message_id: Uuid,
    reached: Reached,
    resets_at: DateTime<Utc>,
    organization_id: Option<&str>,
) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id: message_id,
        kind: SYSTEM_NOTICE_KIND.to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{"type": "text", "text": paused_text(reached, resets_at)}],
            "legacy_attachments": [],
            "usageLimit": {
                "reached": reached.as_str(),
                "resetsAt": resets_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                "organizationId": organization_id,
            },
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

/// A refused pass that may show the paused line.
pub struct Paused<'a> {
    pub conversation_id: Uuid,
    pub pool_id: &'a str,
    pub organization_id: Option<&'a str>,
    pub reached: Reached,
    /// The System agent's account, which posts the line as a System notice
    /// in the conversation it already belongs to.
    pub sender_account_id: &'a str,
    pub now: DateTime<Utc>,
}

/// Records the pause and posts the paused line in `tx`, once per
/// conversation, pool and window. Returns whether this call posted it.
pub async fn post_paused_line(
    tx: &mut Transaction<'_, Postgres>,
    paused: &Paused<'_>,
) -> Result<bool, sqlx_core::Error> {
    let day = paused.now.date_naive();
    let conversation = paused.conversation_id.to_string();
    let inserted: Option<String> = query_scalar(
        "INSERT INTO cloud_usage_notices (scope_kind, scope_id, pool_id, usage_day, notice, reached)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING scope_id",
    )
    .bind(CONVERSATION)
    .bind(&conversation)
    .bind(paused.pool_id)
    .bind(day)
    .bind(PAUSED)
    .bind(paused.reached.as_str())
    .fetch_optional(&mut **tx)
    .await?;
    if inserted.is_none() {
        return Ok(false);
    }
    // The notice row above already keeps the line to one per window.
    let message_id = Uuid::new_v4();
    let request = paused_message(
        message_id,
        paused.reached,
        snapshot::resets_at(paused.now),
        paused.organization_id,
    );
    crate::chat_sync::store::send_message_in_transaction(
        tx,
        paused.sender_account_id,
        paused.conversation_id,
        request,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(true)
}

/// Why a conversation's System agent is paused in the current window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedState {
    pub reached: Reached,
    pub resets_at: String,
    pub since: String,
}

/// The pause recorded for `conversation_id` on `day`, if any.
pub async fn paused_on(
    db: &PgPool,
    conversation_id: Uuid,
    day: NaiveDate,
) -> sqlx_core::Result<Option<PausedState>> {
    let row: Option<(Option<String>, DateTime<Utc>)> = query_as(
        "SELECT reached, created_at FROM cloud_usage_notices
         WHERE scope_kind = $1 AND scope_id = $2 AND usage_day = $3 AND notice = $4
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(CONVERSATION)
    .bind(conversation_id.to_string())
    .bind(day)
    .bind(PAUSED)
    .fetch_optional(db)
    .await?;
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists").and_utc();
    Ok(row.map(|(reached, since)| PausedState {
        reached: reached
            .as_deref()
            .and_then(Reached::parse)
            .unwrap_or(Reached::DailyLimit),
        resets_at: snapshot::resets_at(midnight).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        since: since.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }))
}

/// A threshold notice an organization's owners received in this window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdNotice {
    pub threshold: u8,
    pub at: String,
}

/// The threshold notices sent for `organization_id` on `day`, highest first.
pub async fn thresholds_on(
    db: &PgPool,
    organization_id: &str,
    day: NaiveDate,
) -> sqlx_core::Result<Vec<ThresholdNotice>> {
    let rows: Vec<(String, DateTime<Utc>)> = query_as(
        "SELECT notice, min(created_at) FROM cloud_usage_notices
         WHERE scope_kind = $1 AND scope_id = $2 AND usage_day = $3 AND notice <> $4
         GROUP BY notice ORDER BY notice DESC",
    )
    .bind(ORGANIZATION)
    .bind(organization_id)
    .bind(day)
    .bind(PAUSED)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(notice, at)| ThresholdNotice {
            threshold: if notice == "threshold_90" { 90 } else { 75 },
            at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        })
        .collect())
}

/// The highest threshold a pool's daily caps have passed, from its pool-wide
/// snapshots.
pub fn passed_threshold(snapshots: &[snapshot::UsageSnapshot]) -> Option<u8> {
    let highest = snapshots
        .iter()
        .filter(|snapshot| snapshot.scope == snapshot::Scope::Pool && snapshot.limit.is_some())
        .map(|snapshot| snapshot.used_percent)
        .max()?;
    THRESHOLDS
        .into_iter()
        .find(|threshold| highest >= *threshold)
}

/// One owner notice to send: the organization and the threshold it passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewThreshold {
    pub organization_id: String,
    pub threshold: u8,
}

/// Records the threshold notices due as of `now` for every organization
/// that used a capped pool in this window. Each organization gets each
/// threshold once per window; when both pass at once, both are recorded and
/// only the higher one is returned to send.
pub async fn record_thresholds(
    db: &PgPool,
    pools: &ResourcePools,
    now: DateTime<Utc>,
) -> sqlx_core::Result<Vec<NewThreshold>> {
    let day = now.date_naive();
    let mut due = Vec::new();
    for pool in pools.pools() {
        let limits = pool.limits();
        if pool.is_stopped() || (limits.pool_runs.is_none() && limits.pool_spend_micros.is_none()) {
            continue;
        }
        let snapshots = snapshot::load(db, pool, None, now).await?;
        let Some(passed) = passed_threshold(&snapshots) else {
            continue;
        };
        for threshold in THRESHOLDS.into_iter().filter(|t| *t <= passed) {
            // Organizations whose runs this pool admitted today.
            let inserted: Vec<String> = query_scalar(
                "INSERT INTO cloud_usage_notices (scope_kind, scope_id, pool_id, usage_day, notice)
                 SELECT DISTINCT $1, reservation.organization_id, $2, $3, $4
                 FROM cloud_resource_pool_reservations reservation
                 WHERE reservation.pool_id = $2 AND reservation.usage_day = $3
                   AND reservation.organization_id IS NOT NULL
                 ON CONFLICT DO NOTHING
                 RETURNING scope_id",
            )
            .bind(ORGANIZATION)
            .bind(pool.id())
            .bind(day)
            .bind(threshold_notice(threshold))
            .fetch_all(db)
            .await?;
            for organization_id in inserted {
                if !due
                    .iter()
                    .any(|notice: &NewThreshold| notice.organization_id == organization_id)
                {
                    due.push(NewThreshold {
                        organization_id,
                        threshold,
                    });
                }
            }
        }
    }
    Ok(due)
}

/// Records due threshold notices and sends each to the organization's
/// owners' devices. Delivery is best effort; the record is what clients
/// show in the usage page. There is no email: no notification setting
/// allows usage email yet.
pub async fn notify_owners(
    db: &PgPool,
    pools: &ResourcePools,
    push: Option<&PushNotificationService>,
    now: DateTime<Utc>,
) -> sqlx_core::Result<usize> {
    let due = record_thresholds(db, pools, now).await?;
    let Some(push) = push else {
        return Ok(due.len());
    };
    for notice in &due {
        let owners: Vec<String> = query_scalar(
            "SELECT account_id FROM cloud_organization_members
             WHERE organization_id = $1 AND role = 'owner' ORDER BY account_id",
        )
        .bind(&notice.organization_id)
        .fetch_all(db)
        .await?;
        let body = threshold_text(notice.threshold);
        for account_id in owners {
            push.send_usage_notice(
                db,
                &UsageNoticePush {
                    account_id: &account_id,
                    organization_id: &notice.organization_id,
                    body: &body,
                },
            )
            .await;
        }
    }
    Ok(due.len())
}

/// The owner notice for a passed threshold.
pub fn threshold_text(threshold: u8) -> String {
    format!("{threshold}% of today's limit used.")
}
