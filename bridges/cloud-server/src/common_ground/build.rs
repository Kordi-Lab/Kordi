//! Card builds: gather the sources the owner turned on, redact them, and
//! queue one background run on the Kordi-operated key. The run's reply
//! becomes the card when it completes.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::Response, Extension, Json};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::prompt::{self, Gathered};
use super::redact::{redact, squeeze};
use super::{card, db_error, err, limited, BUILD_LIMIT, RUN_PREFIX};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::{auth::routes::CloudSession, server::ServerState};

const MAX_DEVICE_GROUPS: usize = 4;
const MAX_DEVICE_ITEMS: usize = 300;
const MAX_LINKS: usize = 20;
const MAX_NOTES_CHARS: usize = 4000;
const MAX_TEXT_CHARS: usize = 600;
const MAX_TITLE_CHARS: usize = 140;
const MAX_MEMORIES: usize = 200;
/// Connector events from about the last six months.
const CONNECTOR_DAYS: i64 = 183;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct BuildRequest {
    /// The account's own saved memories.
    memory: bool,
    /// Recent events from connected accounts.
    connectors: bool,
    /// Titles and dates the app read on the device after the person allowed
    /// access (calendar events, reminders).
    device: Vec<DeviceGroup>,
    /// Links and text separated by `;` or new lines. Links are kept as given;
    /// the server does not fetch pages.
    links: String,
    notes: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct DeviceGroup {
    source: String,
    items: Vec<DeviceItem>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct DeviceItem {
    title: String,
    date: Option<String>,
}

fn day(value: Option<&str>) -> Option<String> {
    let value = value?.get(..10)?;
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|d| d.to_string())
}

fn item(
    source: &str,
    title: &str,
    date: Option<String>,
    url: Option<String>,
    text: &str,
) -> Gathered {
    Gathered {
        source: squeeze(source, 40),
        title: squeeze(&redact(title), MAX_TITLE_CHARS),
        date,
        url,
        text: squeeze(&redact(text), MAX_TEXT_CHARS),
    }
}

fn link_url(entry: &str) -> Option<String> {
    let lower = entry.to_ascii_lowercase();
    if (lower.starts_with("https://") || lower.starts_with("http://")) && !entry.contains(' ') {
        return Some(entry.to_string());
    }
    let host = entry.split('/').next()?;
    let looks_like_host = !entry.contains(' ')
        && host.contains('.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    looks_like_host.then(|| format!("https://{entry}"))
}

/// The text fields of a connector event summary, in order.
fn summary_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if !text.trim().is_empty() => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|v| summary_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| summary_strings(v, out)),
        _ => {}
    }
}

fn summary_title(summary: &Value) -> Option<String> {
    ["title", "subject", "summary", "name"]
        .iter()
        .find_map(|key| summary.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "gmail" => "Gmail",
        "google_calendar" => "Google Calendar",
        "github" => "GitHub",
        "slack" => "Slack",
        other => other,
    }
}

/// What the build reads, in the order the model sees it.
pub(super) async fn gather(
    pool: &PgPool,
    account: &str,
    request: &BuildRequest,
) -> sqlx_core::Result<(Vec<Gathered>, Vec<String>)> {
    let mut evidence = Vec::new();
    let mut used = Vec::new();
    if request.memory {
        let list = crate::memory_store::list(pool, account)
            .await
            .map_err(|_| sqlx_core::Error::Protocol("Could not read memories.".into()))?;
        // Only memories the account saved itself: group memories can be
        // about other people.
        let own: Vec<_> = if list.settings.memory_enabled {
            list.memories
                .iter()
                .filter(|m| m.owner_account_id == account)
                .take(MAX_MEMORIES)
                .collect()
        } else {
            Vec::new()
        };
        for memory in &own {
            let title: String = memory.text.chars().take(80).collect();
            evidence.push(item(
                "Memory",
                &title,
                day(Some(&memory.updated_at)),
                None,
                &memory.text,
            ));
        }
        if !own.is_empty() {
            used.push("Memory".to_string());
        }
    }
    if request.connectors {
        let since = Utc::now() - Duration::days(CONNECTOR_DAYS);
        let events = crate::connectors::digest_input::recent_events(pool, account, since).await?;
        let mut providers = Vec::new();
        for event in events {
            let mut strings = Vec::new();
            summary_strings(&event.summary, &mut strings);
            let title = summary_title(&event.summary).unwrap_or_else(|| event.kind.clone());
            let source = provider_label(&event.provider).to_string();
            evidence.push(item(
                &source,
                &title,
                day(Some(&event.occurred_at)),
                None,
                &strings.join(" · "),
            ));
            if !providers.contains(&source) {
                providers.push(source);
            }
        }
        used.extend(providers);
    }
    for group in request.device.iter().take(MAX_DEVICE_GROUPS) {
        let source = squeeze(&group.source, 40);
        let source = if source.is_empty() {
            "Device".to_string()
        } else {
            source
        };
        let mut count = 0;
        for entry in group.items.iter().take(MAX_DEVICE_ITEMS) {
            let title = squeeze(&entry.title, MAX_TITLE_CHARS);
            if !title.is_empty() {
                evidence.push(item(
                    &source,
                    &title,
                    day(entry.date.as_deref()),
                    None,
                    &title,
                ));
                count += 1;
            }
        }
        if count > 0 {
            used.push(source);
        }
    }
    let today = Utc::now().date_naive().to_string();
    let entries: Vec<&str> = request
        .links
        .split([';', '\n'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .take(MAX_LINKS)
        .collect();
    for entry in &entries {
        let url = link_url(entry);
        let source = if url.is_some() { "Link" } else { "Your words" };
        // The link itself is the reference; its text is what the model reads.
        let mut gathered = item(source, entry, Some(today.clone()), url.clone(), entry);
        if let Some(url) = url {
            gathered.title = squeeze(&url, MAX_TITLE_CHARS);
            gathered.text = squeeze(entry, MAX_TEXT_CHARS);
        }
        evidence.push(gathered);
    }
    if !entries.is_empty() {
        used.push("Links".to_string());
    }
    let notes: String = request.notes.trim().chars().take(MAX_NOTES_CHARS).collect();
    if !notes.is_empty() {
        evidence.push(Gathered {
            source: "Notes".into(),
            title: "Your notes".into(),
            date: Some(today),
            url: None,
            text: redact(&notes),
        });
        used.push("Notes".to_string());
    }
    Ok((evidence, used))
}

pub(super) async fn start(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<BuildRequest>,
) -> Response {
    let Some(pip) = state.pip() else {
        return super::unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let (evidence, used) = match gather(pool, account, &request).await {
        Ok(gathered) => gathered,
        Err(error) => return db_error(error),
    };
    if evidence.is_empty() {
        return err(
            "common_ground_no_sources",
            "Choose at least one source.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(BUILD_LIMIT, account)
        .await
    {
        return limited(retry_after);
    }
    let config = pip.config();
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let today = Utc::now().date_naive().to_string();
    let result = async {
        let mut tx = pool.begin().await?;
        query("INSERT INTO cloud_common_ground_cards (account_id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(account)
            .execute(&mut *tx)
            .await?;
        let sql = format!(
            "UPDATE cloud_common_ground_cards card SET active_run_id = $2, build_started_at = now(),
                 build_evidence_json = $3, build_error_code = NULL, updated_at = now()
             WHERE card.account_id = $1 AND NOT ({})",
            card::BUILD_IN_FLIGHT_SQL
        );
        let reserved = query(&sql)
            .bind(account)
            .bind(&run_id)
            .bind(serde_json::to_value(&evidence).unwrap_or_default())
            .execute(&mut *tx)
            .await?;
        if reserved.rows_affected() == 0 {
            return Ok(false);
        }
        // The run belongs to the Kordi-operated service account, so it uses
        // the Kordi key rather than the member's own provider. It has no
        // chat and no connector tools; the member's evidence is the prompt.
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_agent_fallback_runs (
                 run_id, idempotency_key, request_message_id, session_id, owner_account_id,
                 requester_account_id, status, prompt, system_prompt, runtime_route_json,
                 created_at, updated_at, run_trigger, connector_audience
             ) VALUES ($1, $1, $1, $2, $3, $4, 'queued', $5, $6, $7, $8, $8, 'background', 'owner_private')",
        )
        .bind(&run_id)
        .bind(format!("common-ground:{account}"))
        .bind(&config.account_id)
        .bind(account)
        .bind(prompt::user_prompt(&today, &evidence))
        .bind(prompt::SYSTEM_PROMPT)
        .bind(config.model_routing())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    match result {
        Ok(true) => match card::load(pool, account).await {
            Ok(Some(row)) => {
                use axum::response::IntoResponse;
                let mut view = row.owner_view(Utc::now().date_naive());
                view["used"] = json!(used);
                (StatusCode::ACCEPTED, Json(view)).into_response()
            }
            Ok(None) => db_error(sqlx_core::Error::RowNotFound),
            Err(error) => db_error(error),
        },
        Ok(false) => err(
            "common_ground_build_in_progress",
            "Your card is already being built.",
            StatusCode::CONFLICT,
        ),
        Err(error) => db_error(error),
    }
}

/// Stores the card from a finished run. A reply that is not a card fails
/// the build instead.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<(String, Value)> = query_as(
        "SELECT card.account_id, card.build_evidence_json
         FROM cloud_common_ground_cards card
         JOIN cloud_agent_fallback_runs run ON run.run_id = card.active_run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((account, gathered)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let gathered: Vec<Gathered> = serde_json::from_value(gathered).unwrap_or_default();
    let Some((topics, evidence)) = prompt::parse_reply(text, &gathered) else {
        eprintln!("[common-ground] Rejected run {run_id}: the reply is not a card");
        return fail(pool, run_id, Some(runner_id), "invalid_output").await;
    };
    let mut tx = pool.begin().await?;
    let now = Utc::now().to_rfc3339();
    let changed = query(
        "UPDATE cloud_agent_fallback_runs SET status = 'completed', completed_at = $3, updated_at = $3
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(sqlx_core::Error::RowNotFound);
    }
    // A rebuild starts with nothing hidden: the topics are new.
    query(
        "UPDATE cloud_common_ground_cards SET topics_json = $2, evidence_json = $3,
             hidden_json = '[]'::jsonb, active_run_id = NULL, build_evidence_json = NULL,
             build_error_code = NULL, built_at = now(), revision = revision + 1, updated_at = now()
         WHERE account_id = $1 AND active_run_id = $4",
    )
    .bind(&account)
    .bind(serde_json::to_value(&topics).unwrap_or_default())
    .bind(serde_json::to_value(&evidence).unwrap_or_default())
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    super::hint(
        &mut tx,
        &account,
        "common_ground.card.updated",
        json!({ "built": true }),
    )
    .await?;
    tx.commit().await
}

pub async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_agent_fallback_runs SET status = 'failed', error_code = $3,
             error_message = 'Card build failed.', updated_at = $4
         WHERE run_id = $1 AND ($2::text IS NULL OR claimed_by = $2)
           AND status IN ('queued', 'leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(code)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await?;
    let account: Option<(String,)> = query_as(
        "UPDATE cloud_common_ground_cards SET active_run_id = NULL, build_evidence_json = NULL,
             build_error_code = $2, updated_at = now()
         WHERE active_run_id = $1 RETURNING account_id",
    )
    .bind(run_id)
    .bind(code)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((account,)) = account {
        super::hint(
            &mut tx,
            &account,
            "common_ground.card.updated",
            json!({ "built": false }),
        )
        .await?;
    }
    tx.commit().await
}

#[cfg(test)]
pub(super) fn request_for_tests(notes: &str, links: &str) -> BuildRequest {
    BuildRequest {
        notes: notes.into(),
        links: links.into(),
        ..BuildRequest::default()
    }
}

#[cfg(test)]
pub(super) fn link_url_for_tests(entry: &str) -> Option<String> {
    link_url(entry)
}
