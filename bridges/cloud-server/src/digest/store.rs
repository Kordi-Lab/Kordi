use super::models::*;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::collections::{BTreeSet, HashMap};

type Result<T> = std::result::Result<T, sqlx_core::Error>;
pub use super::cadence::{fail, Trigger};
#[cfg(test)]
pub use super::evidence::authorized_input_sources;
pub use super::evidence::input_is_currently_authorized;
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
    let rows:Vec<(Value,i64,chrono::DateTime<Utc>)>=query_as("SELECT payload,revision,updated_at FROM cloud_calendar_events WHERE account_id=$1 ORDER BY (payload->>'startAt')::timestamptz,event_id LIMIT $2").bind(account).bind(super::sync_routes::CALENDAR_CAPACITY + 1).fetch_all(pool).await?;
    // Never expose a truncated snapshot: clients interpret missing rows as deletions.
    if rows.len() as i64 > super::sync_routes::CALENDAR_CAPACITY {
        return Err(sqlx_core::Error::Protocol(
            "Calendar snapshot exceeds the supported capacity".into(),
        ));
    }
    let mut events = Vec::new();
    for (value, revision, updated_at) in rows {
        if let Ok(mut event) = serde_json::from_value::<CalendarEvent>(value) {
            if authorized(pool, account, &event.source_ids).await? {
                event.revision = revision;
                event.updated_at =
                    Some(updated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                events.push(event);
            }
        }
    }
    Ok(events)
}

/// Inserts a revision-0 event or updates an existing row whose revision matches.
/// Returns `None` when the expected revision no longer matches (or a new event already exists).
pub async fn upsert_event(
    tx: &mut sqlx_postgres::PgConnection,
    account: &str,
    event: &CalendarEvent,
) -> Result<Option<(Value, i64)>> {
    let value = serde_json::to_value(event).unwrap();
    let row:Option<(Value,i64)>=query_as("INSERT INTO cloud_calendar_events(account_id,event_id,payload) SELECT $1,$2,$3 WHERE $4=0 ON CONFLICT(account_id,event_id) DO UPDATE SET payload=cloud_calendar_events.payload || $3,revision=cloud_calendar_events.revision+1,updated_at=now() WHERE cloud_calendar_events.revision=$4 RETURNING payload,revision")
        .bind(account).bind(&event.id).bind(&value).bind(event.revision).fetch_optional(&mut *tx).await?;
    if row.is_none() && event.revision > 0 {
        // Existing rows with an expected revision use an explicit update.
        return query_as("UPDATE cloud_calendar_events SET payload=cloud_calendar_events.payload || $3,revision=revision+1,updated_at=now() WHERE account_id=$1 AND event_id=$2 AND revision=$4 RETURNING payload,revision")
            .bind(account).bind(&event.id).bind(&value).bind(event.revision).fetch_optional(&mut *tx).await;
    }
    Ok(row)
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
        connector_events: crate::connectors::digest_input::recent_events(
            pool,
            account,
            Utc::now() - chrono::Duration::days(7),
        )
        .await?,
        memories: super::memories::existing(pool, account).await,
        triage: false,
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
    let value = json!({"version":1,"sources":input.sources,"events":input.calendar_events,"tasks":input.existing_tasks,"locale":input.locale,"timezone":input.timezone,"connectorEvents":input.connector_events,"dueReminders":super::incremental::due_reminders(input)});
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

/// Runs the digest now, as the refresh button does.
pub async fn refresh(pool: &PgPool, account: &str) -> Result<()> {
    refresh_as(pool, account, Trigger::Manual).await
}

pub async fn refresh_as(pool: &PgPool, account: &str, trigger: Trigger) -> Result<()> {
    type DigestState = (
        String,
        String,
        String,
        Option<Value>,
        Option<String>,
        Option<Value>,
        Option<chrono::DateTime<Utc>>,
        bool,
    );
    // A full rebuild is due with the first run after 06:00 in the owner's
    // timezone each day.
    let row:Option<DigestState>=query_as("SELECT locale,timezone,input_hash,snapshot_json,active_run_id,snapshot_input_json,last_change_at,last_full_at IS NULL OR last_full_at < (date_trunc('day', now() AT TIME ZONE timezone - interval '6 hours') + interval '6 hours') AT TIME ZONE timezone FROM cloud_account_digests WHERE account_id=$1 AND (retry_after<=now() OR $2)").bind(account).bind(trigger.requested()).fetch_optional(pool).await?;
    let Some((locale, timezone, old_hash, snapshot, active, saved_input, seen_change, full_due)) =
        row
    else {
        return Ok(());
    };
    let automatic = !trigger.requested();
    let full = trigger == Trigger::Full;
    if active.is_some() || !super::cadence::within_caps(pool, account, trigger).await? {
        return Ok(());
    }
    let previous = snapshot.and_then(|v| serde_json::from_value(v).ok());
    let saved = saved_input
        .and_then(|value| serde_json::from_value::<Input>(value).ok())
        .filter(|saved| saved.viewer_account_id == account);
    let mut input = input(pool, account, &locale, &timezone, previous).await?;
    // The rebuilt input covers the changes marked before it was read. Any later
    // mark, including one from a send that was still committing, changes
    // last_change_at, so the digest stays marked; the update waits for that
    // send's row lock and then compares against what it committed.
    query(
        "UPDATE cloud_account_digests SET dirty_since=NULL,last_change_at=NULL
         WHERE account_id=$1 AND last_change_at IS NOT DISTINCT FROM $2",
    )
    .bind(account)
    .bind(seen_change)
    .execute(pool)
    .await?;
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
    if hash == old_hash && !full {
        return Ok(());
    }
    if let Some(saved) = saved.as_ref().filter(|_| input.previous.is_some()) {
        let changes = super::incremental::Changes::between(saved, &input);
        if changes.is_empty() && !full {
            query("UPDATE cloud_account_digests SET input_hash=$2,error_code=NULL WHERE account_id=$1 AND active_run_id IS NULL")
                .bind(account).bind(&hash).execute(pool).await?;
            return Ok(());
        }
        input.changes = Some(changes);
    }
    // Only changes that can matter start an automatic run; the rest reach
    // the digest with its next run.
    let saved = saved.filter(|_| input.previous.is_some());
    if automatic && !super::changes::relevant(saved.as_ref(), input.changes.as_ref(), account) {
        return Ok(());
    }
    // Other runs send only the changes since the saved snapshot; a full
    // rebuild sends the whole input and reconciles every saved item.
    if full || full_due {
        input.changes = None;
    }
    if input.sources.is_empty() {
        query("UPDATE cloud_account_digests SET snapshot_json=$2,snapshot_input_json=$3,input_json=$3,input_hash=$4,error_code=NULL,revision=revision+1,updated_at=now() WHERE account_id=$1 AND active_run_id IS NULL")
            .bind(account).bind(serde_json::to_value(Output::default()).unwrap()).bind(serde_json::to_value(&input).unwrap()).bind(&hash).execute(pool).await?;
        return Ok(());
    }
    super::queue::queue(pool, account, &input, Some(&hash), trigger).await?;
    Ok(())
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
    if value.get("triage").and_then(Value::as_bool) == Some(true) {
        return super::urgent::complete(pool, run, runner, &account, text).await;
    }
    // Every executor's reply gets the same clean-up before the checks below.
    let text = super::output::normalized_reply(text, &value);
    let input: Input =
        serde_json::from_value(value).map_err(|e| sqlx_core::Error::Decode(Box::new(e)))?;
    // The reason a generated digest is rejected is logged without its content.
    let mut output = match serde_json::from_str::<Output>(text.trim()) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[digest] Rejected run {run}: output is not a digest ({error})");
            return fail(pool, run, Some(runner), "invalid_output").await;
        }
    };
    // Memories are saved after the digest is stored and never kept in it.
    let memories = std::mem::take(&mut output.memories);
    let mut output = match super::incremental::merge_output(&input, output) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[digest] Rejected run {run}: could not merge output ({error:?})");
            return fail(pool, run, Some(runner), "invalid_output").await;
        }
    };
    // Best effort: a failed check keeps the suggestions rather than failing
    // the member's whole digest.
    if let Err(error) = super::pip_guard::drop_pip_conflicts(pool, &input, &mut output).await {
        eprintln!("[digest] Could not check suggestions against PiP plans: {error}");
    }
    if let Err(reason) = validate_output(&output, &input) {
        eprintln!("[digest] Rejected run {run}: {reason}");
        return fail(pool, run, Some(runner), "invalid_output").await;
    }
    // A source edited or removed while the model ran retires the items it
    // supports instead of discarding the run; the next run sees the change.
    let Some(current) = super::evidence::current_input_sources(pool, &account, &input).await?
    else {
        return fail(pool, run, Some(runner), "sources_changed").await;
    };
    super::evidence::retain_supported(&mut output, &current);
    let mut tx = pool.begin().await?;
    let changed=query("UPDATE cloud_agent_fallback_runs SET status='completed',completed_at=$3,updated_at=$3 WHERE run_id=$1 AND claimed_by=$2 AND status IN ('leased','running') AND lease_expires_at>$3").bind(run).bind(runner).bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Err(sqlx_core::Error::RowNotFound);
    }
    query("UPDATE cloud_account_digests SET snapshot_json=$2,snapshot_input_json=input_json,active_run_id=NULL,error_code=NULL,failure_count=0,revision=revision+1,updated_at=now(),last_full_at=CASE WHEN $4 THEN now() ELSE last_full_at END WHERE account_id=$1 AND active_run_id=$3").bind(&account).bind(serde_json::to_value(output).unwrap()).bind(run).bind(input.changes.is_none()).execute(&mut *tx).await?;
    crate::chat_sync::store::append_account_hint(
        &mut tx,
        &account,
        "digest.updated",
        &json!({"updated":true}),
    )
    .await
    .map_err(|_| sqlx_core::Error::Protocol("Could not publish digest update.".into()))?;
    tx.commit().await?;
    super::memories::save_all(pool, run, &account, &current, memories).await;
    Ok(())
}
