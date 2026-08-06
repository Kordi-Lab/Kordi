use serde::Serialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::SKILL_PACK_ID;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDiagnostic {
    pub run_id: String,
    pub session_id: String,
    pub trigger_message_id: String,
    pub status: String,
    pub decision: Option<String>,
    pub breakdown: Option<String>,
    pub selected_skill: Option<String>,
    pub evidence_message_ids: Vec<String>,
    pub skill_pack: String,
    pub route: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
}

type DiagnosticRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    serde_json::Value,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

pub async fn list_run_diagnostics(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<RunDiagnostic>, sqlx_core::Error> {
    let rows: Vec<DiagnosticRow> = query_as(
        "SELECT run_id, session_id, request_message_id, status, proactive_decision,
             proactive_breakdown, proactive_selected_skill,
             proactive_evidence_message_ids_json, proactive_skill_pack, error_code,
             error_message, created_at, updated_at, completed_at
         FROM cloud_agent_fallback_runs
         WHERE owner_account_id = $1
           AND target_agent_id = $2
           AND trigger_kind = 'proactive'
         ORDER BY created_at DESC
         LIMIT $3",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let duration_ms = row.13.as_deref().and_then(|completed_at| {
                let created_at = chrono::DateTime::parse_from_rfc3339(&row.11).ok()?;
                let completed_at = chrono::DateTime::parse_from_rfc3339(completed_at).ok()?;
                Some((completed_at - created_at).num_milliseconds().max(0))
            });
            RunDiagnostic {
                run_id: row.0,
                session_id: row.1,
                trigger_message_id: row.2,
                status: row.3,
                decision: row.4,
                breakdown: row.5,
                selected_skill: row.6,
                evidence_message_ids: serde_json::from_value(row.7).unwrap_or_default(),
                skill_pack: row.8.unwrap_or_else(|| SKILL_PACK_ID.to_string()),
                route: "cloud_fallback".to_string(),
                error_code: row.9,
                error_message: row.10,
                created_at: row.11,
                updated_at: row.12,
                completed_at: row.13,
                duration_ms,
            }
        })
        .collect())
}
