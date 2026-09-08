use super::models::*;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

type Result<T> = std::result::Result<T, sqlx_core::Error>;
use super::source_reader::source_page;
#[cfg(test)]
pub use super::source_reader::visible_text;
pub use super::source_reader::{authorized, sources};

pub async fn initialize_preferences(
    pool: &PgPool,
    account: &str,
    locale: &str,
    timezone: &str,
) -> Result<()> {
    query("INSERT INTO cloud_account_digests(account_id,locale,timezone) VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING")
        .bind(account).bind(locale).bind(timezone).execute(pool).await?;
    Ok(())
}

pub async fn calendar(pool: &PgPool, account: &str) -> Result<Vec<CalendarEvent>> {
    let rows:Vec<(Value,i64)>=query_as("SELECT payload,revision FROM cloud_calendar_events WHERE account_id=$1 ORDER BY (payload->>'startAt')::timestamptz,event_id LIMIT 1000").bind(account).fetch_all(pool).await?;
    let mut events = Vec::new();
    for (value, revision) in rows {
        if let Ok(mut event) = serde_json::from_value::<CalendarEvent>(value) {
            if authorized(pool, account, &event.source_ids).await? {
                event.revision = revision;
                events.push(event);
            }
        }
    }
    Ok(events)
}

pub async fn input(
    pool: &PgPool,
    account: &str,
    locale: &str,
    timezone: &str,
    mut previous: Option<Output>,
) -> Result<Input> {
    let (mut sources, mut partial) = source_page(pool, account, None).await?;
    sources.truncate(500);
    let reply_ids: Vec<_> = sources
        .iter()
        .filter_map(|source| source.reply_to_source_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(200)
        .collect();
    for source in self::sources(pool, account, Some(&reply_ids)).await? {
        if !sources.iter().any(|existing| existing.id == source.id) {
            sources.push(source);
        }
    }
    if let Some(previous) = &previous {
        let ids: Vec<_> = previous
            .commitments
            .iter()
            .filter(|i| i.kind != "done")
            .flat_map(|i| i.source_ids.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(200)
            .collect();
        for source in self::sources(pool, account, Some(&ids)).await? {
            if !sources.iter().any(|s| s.id == source.id) {
                sources.push(source);
            }
        }
    }
    let mut retained: BTreeSet<_> = previous
        .as_ref()
        .into_iter()
        .flat_map(|p| {
            p.commitments
                .iter()
                .filter(|i| i.kind != "done")
                .flat_map(|i| i.source_ids.iter().cloned())
        })
        .collect();
    retained.extend(reply_ids);
    sources.sort_by_key(|source| !retained.contains(&source.id));
    let mut budget = 0;
    sources.retain_mut(|s| {
        if budget >= 100_000 {
            partial = true;
            return false;
        }
        if s.text.chars().count() > 2000 {
            s.text = s.text.chars().take(2000).collect();
            partial = true;
        }
        budget += serde_json::to_vec(s)
            .map(|v| v.len())
            .unwrap_or(s.text.len());
        true
    });
    sources.sort_by(|a, b| a.id.cmp(&b.id));
    let source_ids: BTreeSet<_> = sources.iter().map(|source| source.id.clone()).collect();
    for source in &mut sources {
        if source
            .reply_to_source_id
            .as_ref()
            .is_some_and(|id| !source_ids.contains(id))
        {
            source.reply_to_source_id = None;
        }
    }
    let sessions: Vec<_> = sources
        .iter()
        .map(|s| s.session_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    type TaskContext = (String, String, String, Option<String>, Option<String>);
    let tasks:Vec<TaskContext>=query_as("SELECT task_id,LEFT(title,500),status,LEFT(summary,1000),target_account_id FROM cloud_session_tasks WHERE session_id=ANY($1) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(sessions).fetch_all(pool).await?;
    if let Some(previous) = &mut previous {
        let ids: BTreeSet<_> = sources.iter().map(|s| s.id.as_str()).collect();
        for items in [
            &mut previous.claims,
            &mut previous.commitments,
            &mut previous.suggestions,
            &mut previous.calendar_candidates,
        ] {
            items.retain(|item| item.source_ids.iter().all(|id| ids.contains(id.as_str())));
        }
    }
    Ok(Input {
        sources,
        calendar_events: {
            let mut events = calendar(pool, account).await?;
            events.retain(|e| {
                chrono::DateTime::parse_from_rfc3339(e.end_at.as_ref().unwrap_or(&e.start_at))
                    .map(|d| d > Utc::now() - chrono::Duration::days(7))
                    .unwrap_or(false)
            });
            if events.len() > 50 {
                events.truncate(50);
                partial = true;
            }
            for e in &mut events {
                if e.description.len() > 1000 {
                    e.description = e.description.chars().take(250).collect();
                    partial = true;
                }
            }
            events
        },
        existing_tasks: json!(tasks),
        previous,
        locale: locale.into(),
        timezone: timezone.into(),
        partial,
        as_of: Utc::now().to_rfc3339(),
        viewer_account_id: account.into(),
        changes: None,
    })
}

pub(super) fn retain_previous_evidence(
    previous: &mut Output,
    saved: &[Source],
    current: &[Source],
) {
    let versions: HashMap<_, _> = current
        .iter()
        .map(|source| (source.id.as_str(), source.version))
        .collect();
    let unchanged: BTreeSet<_> = saved
        .iter()
        .filter(|source| versions.get(source.id.as_str()) == Some(&source.version))
        .map(|source| source.id.as_str())
        .collect();
    for items in [
        &mut previous.claims,
        &mut previous.commitments,
        &mut previous.suggestions,
        &mut previous.calendar_candidates,
    ] {
        items.retain(|item| {
            item.source_ids
                .iter()
                .all(|id| unchanged.contains(id.as_str()))
        });
    }
}

fn input_hash(input: &Input) -> String {
    let value = json!({"version":1,"sources":input.sources,"events":input.calendar_events,"tasks":input.existing_tasks,"locale":input.locale,"timezone":input.timezone,"dueReminders":super::incremental::due_reminders(input)});
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

pub async fn refresh(pool: &PgPool, account: &str) -> Result<()> {
    type DigestState = (
        String,
        String,
        String,
        Option<Value>,
        Option<String>,
        Option<Value>,
    );
    let row:Option<DigestState>=query_as("SELECT locale,timezone,input_hash,snapshot_json,active_run_id,snapshot_input_json FROM cloud_account_digests WHERE account_id=$1 AND retry_after<=now()").bind(account).fetch_optional(pool).await?;
    let Some((locale, timezone, old_hash, snapshot, active, saved_input)) = row else {
        return Ok(());
    };
    if active.is_some() {
        return Ok(());
    }
    let previous = snapshot.and_then(|v| serde_json::from_value(v).ok());
    let saved = saved_input
        .and_then(|value| serde_json::from_value::<Input>(value).ok())
        .filter(|saved| saved.viewer_account_id == account);
    let mut input = input(pool, account, &locale, &timezone, previous).await?;
    if let Some(previous) = &mut input.previous {
        retain_previous_evidence(
            previous,
            saved
                .as_ref()
                .map(|input| input.sources.as_slice())
                .unwrap_or(&[]),
            &input.sources,
        );
    }
    let hash = input_hash(&input);
    if hash == old_hash {
        return Ok(());
    }
    if let Some(saved) = saved.as_ref().filter(|_| input.previous.is_some()) {
        let changes = super::incremental::Changes::between(saved, &input);
        if changes.is_empty() {
            query("UPDATE cloud_account_digests SET input_hash=$2,error_code=NULL WHERE account_id=$1 AND active_run_id IS NULL")
                .bind(account).bind(&hash).execute(pool).await?;
            return Ok(());
        }
        input.changes = Some(changes);
    }
    if input.sources.is_empty() {
        query("UPDATE cloud_account_digests SET snapshot_json=$2,snapshot_input_json=$3,input_json=$3,input_hash=$4,error_code=NULL,revision=revision+1,updated_at=now() WHERE account_id=$1 AND active_run_id IS NULL")
            .bind(account).bind(serde_json::to_value(Output::default()).unwrap()).bind(serde_json::to_value(&input).unwrap()).bind(&hash).execute(pool).await?;
        return Ok(());
    }
    let auth:Option<(String,)>=query_as("SELECT snapshot_id FROM cloud_agent_provider_auth_snapshots WHERE account_id=$1 AND revoked_at IS NULL LIMIT 1").bind(account).fetch_optional(pool).await?;
    if auth.is_none() {
        query("UPDATE cloud_account_digests SET error_code='missing_provider_auth',retry_after=now()+interval '30 seconds' WHERE account_id=$1").bind(account).execute(pool).await?;
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    let run = format!("{}{}", super::RUN_PREFIX, Uuid::new_v4().simple());
    let changed=query("UPDATE cloud_account_digests SET active_run_id=$2,input_hash=$3,input_json=$4,error_code=NULL WHERE account_id=$1 AND active_run_id IS NULL AND input_hash<>$3")
        .bind(account).bind(&run).bind(&hash).bind(serde_json::to_value(&input).unwrap()).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs (run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,system_prompt,runtime_route_json,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$3,'queued',$4,$5,'{}',$6,$6)")
        .bind(&run).bind(format!("digest:{account}")).bind(account).bind(serde_json::to_string(&input).unwrap()).bind(super::SYSTEM_PROMPT).bind(now).execute(&mut *tx).await?;
    tx.commit().await
}

pub async fn input_is_currently_authorized(
    pool: &PgPool,
    account: &str,
    input: &Input,
) -> Result<bool> {
    Ok(authorized_input_sources(pool, account, input)
        .await?
        .is_some())
}

pub async fn authorized_input_sources(
    pool: &PgPool,
    account: &str,
    input: &Input,
) -> Result<Option<Vec<Source>>> {
    let ids: Vec<_> = input.sources.iter().map(|s| s.id.clone()).collect();
    let current = sources(pool, account, Some(&ids)).await?;
    let versions: HashMap<_, _> = current.iter().map(|s| (&s.id, s.version)).collect();
    if !input
        .sources
        .iter()
        .all(|s| versions.get(&s.id) == Some(&s.version))
    {
        return Ok(None);
    }
    for event in &input.calendar_events {
        if !authorized(pool, account, &event.source_ids).await? {
            return Ok(None);
        }
    }
    let current: HashMap<_, _> = current
        .into_iter()
        .map(|source| (source.id.clone(), source))
        .collect();
    let mut refs = input.sources.clone();
    for source in &mut refs {
        let latest = &current[&source.id];
        source.sender_name = latest.sender_name.clone();
        source.sender_avatar_url = latest.sender_avatar_url.clone();
        source.session_title = latest.session_title.clone();
        source.is_agent = latest.is_agent;
        source.agent_id = latest.agent_id.clone();
        source.agent_owner_name = latest.agent_owner_name.clone();
        source.agent_avatar_url = latest.agent_avatar_url.clone();
        source.reply_to_source_id = latest
            .reply_to_source_id
            .clone()
            .filter(|id| ids.contains(id));
    }
    Ok(Some(refs))
}

pub async fn revalidate_run(pool: &PgPool, run: &str) -> Result<bool> {
    let row: Option<(String, Value)> =
        query_as("SELECT account_id,input_json FROM cloud_account_digests WHERE active_run_id=$1")
            .bind(run)
            .fetch_optional(pool)
            .await?;
    let Some((account, value)) = row else {
        return Ok(false);
    };
    let valid = if let Ok(input) = serde_json::from_value::<Input>(value) {
        input_is_currently_authorized(pool, &account, &input).await?
    } else {
        false
    };
    if !valid {
        fail(pool, run, None, "sources_changed").await?;
    }
    Ok(valid)
}

pub async fn complete(pool: &PgPool, run: &str, runner: &str, text: &str) -> Result<()> {
    let row:Option<(String,Value)>=query_as("SELECT d.account_id,d.input_json FROM cloud_account_digests d JOIN cloud_agent_fallback_runs r ON r.run_id=d.active_run_id WHERE r.run_id=$1 AND r.claimed_by=$2 AND r.status IN ('leased','running') AND r.lease_expires_at>$3").bind(run).bind(runner).bind(Utc::now().to_rfc3339()).fetch_optional(pool).await?;
    let Some((account, value)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let input: Input =
        serde_json::from_value(value).map_err(|e| sqlx_core::Error::Decode(Box::new(e)))?;
    let output = serde_json::from_str::<Output>(text.trim());
    let Ok(output) = output else {
        return fail(pool, run, Some(runner), "invalid_output").await;
    };
    let Ok(output) = super::incremental::merge_output(&input, output) else {
        return fail(pool, run, Some(runner), "invalid_output").await;
    };
    if validate_output(&output, &input).is_err() {
        return fail(pool, run, Some(runner), "invalid_output").await;
    }
    if !input_is_currently_authorized(pool, &account, &input).await? {
        return fail(pool, run, Some(runner), "sources_changed").await;
    }
    let mut tx = pool.begin().await?;
    let changed=query("UPDATE cloud_agent_fallback_runs SET status='completed',completed_at=$3,updated_at=$3 WHERE run_id=$1 AND claimed_by=$2 AND status IN ('leased','running') AND lease_expires_at>$3").bind(run).bind(runner).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Err(sqlx_core::Error::RowNotFound);
    }
    query("UPDATE cloud_account_digests SET snapshot_json=$2,snapshot_input_json=input_json,active_run_id=NULL,error_code=NULL,revision=revision+1,updated_at=now() WHERE account_id=$1 AND active_run_id=$3").bind(&account).bind(serde_json::to_value(output).unwrap()).bind(run).execute(&mut *tx).await?;
    crate::chat_sync::store::append_account_hint(
        &mut tx,
        &account,
        "digest.updated",
        &json!({"updated":true}),
    )
    .await
    .map_err(|_| sqlx_core::Error::Protocol("Could not publish digest update.".into()))?;
    tx.commit().await
}

pub async fn fail(pool: &PgPool, run: &str, runner: Option<&str>, code: &str) -> Result<()> {
    let mut tx = pool.begin().await?;
    let changed=query("UPDATE cloud_agent_fallback_runs SET status='failed',error_code=$3,error_message='Digest update failed.',updated_at=$4 WHERE run_id=$1 AND ($2::text IS NULL OR claimed_by=$2) AND status IN ('queued','leased','running')").bind(run).bind(runner).bind(code).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    if changed.rows_affected() > 0 {
        query("UPDATE cloud_account_digests SET active_run_id=NULL,error_code=$2,retry_after=now()+CASE WHEN $2='sources_changed' THEN interval '1 second' ELSE interval '30 seconds' END,input_hash='' WHERE active_run_id=$1").bind(run).bind(code).execute(&mut *tx).await?;
    }
    tx.commit().await
}
