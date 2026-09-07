use super::models::*;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

type Result<T> = std::result::Result<T, sqlx_core::Error>;
// Keep authorization identical for aggregation, cached reads, evidence and conversion.
const SOURCE_FROM: &str = " FROM cloud_chat_messages m
 JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id
 JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id AND member.account_id=$1 AND member.membership_state='active'
 JOIN cloud_accounts sender ON sender.account_id=m.sender_account_id
 LEFT JOIN cloud_default_agent_profiles profile ON profile.owner_account_id=m.sender_account_id
 LEFT JOIN cloud_agent_fallback_runs source_run ON source_run.response_message_id=m.message_id::text AND source_run.owner_account_id=m.sender_account_id
 WHERE m.deleted_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM cloud_chat_message_visibility v WHERE v.account_id=$1 AND v.message_id=m.message_id)
 AND NOT EXISTS (SELECT 1 FROM cloud_account_session_visibility v WHERE v.account_id=$1 AND v.session_id=COALESCE(c.legacy_session_id,c.conversation_id::text) AND (v.hidden_at IS NOT NULL OR v.deleted_at IS NOT NULL))";

pub fn visible_text(content: &Value) -> Option<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let blocks = content.get("blocks")?.as_array()?;
    let mut texts = Vec::new();
    for block in blocks {
        if block.get("type")?.as_str()? != "text" {
            continue;
        }
        let raw = block.get("text")?.as_str()?.trim();
        if raw.starts_with("kordi-cloud-") {
            let (prefix, encoded) = raw.split_once(':')?;
            let value: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
            let kind = value.get("kind")?.as_str()?;
            let text = match (prefix, kind) {
                ("kordi-cloud-message", "message")
                | ("kordi-cloud-agent-response", "agent-response") => {
                    value.get("text")?.as_str()?
                }
                ("kordi-cloud-group", "group-message") => {
                    value.get("message")?.get("text")?.as_str()?
                }
                _ => return None,
            };
            texts.push(text.to_string());
        } else if !raw.is_empty() {
            texts.push(raw.to_string());
        }
    }
    (!texts.is_empty()).then(|| texts.join("\n"))
}

async fn source_page(
    pool: &PgPool,
    account: &str,
    ids: Option<&[String]>,
) -> Result<(Vec<Source>, bool)> {
    let suffix = if ids.is_some() {
        " AND m.message_id::text=ANY($2) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 700"
    } else {
        " AND (m.generation_status IS NULL OR m.generation_status IN ('complete','completed')) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 501"
    };
    let sql=format!("SELECT m.message_id::text,c.conversation_id::text,COALESCE(c.legacy_session_id,c.conversation_id::text),COALESCE(member.personal_title,c.shared_title,c.group_title,'Conversation'),m.sender_account_id,COALESCE(sender.display_name,'Contact'),m.content,m.created_at,m.version,m.message_kind,profile.display_name,profile.avatar_url,source_run.execution_agent_id{SOURCE_FROM}{suffix}");
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        Value,
        chrono::DateTime<chrono::Utc>,
        i32,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let mut request = query_as::<_, Row>(&sql).bind(account);
    if let Some(ids) = ids {
        request = request.bind(ids);
    }
    let rows = request.fetch_all(pool).await?;
    let limited = ids.is_none() && rows.len() > 500;
    let source_agent_id = |r: &Row| {
        r.12.clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| super::source_identity::agent_id(&r.6, &r.9, &r.4))
    };
    let agent_ids: Vec<_> = rows
        .iter()
        .filter_map(source_agent_id)
        .filter(|id| !id.starts_with("cloud-agent:"))
        .collect();
    let definitions: Vec<(String, String, String)> = if agent_ids.is_empty() {
        Vec::new()
    } else {
        let owners: Vec<_> = rows.iter().map(|r| r.4.clone()).collect();
        query_as("SELECT agent_id,owner_account_id,name FROM cloud_agent_definitions WHERE agent_id=ANY($1) AND owner_account_id=ANY($2)")
            .bind(agent_ids).bind(owners).fetch_all(pool).await?
    };
    let names: HashMap<_, _> = definitions
        .into_iter()
        .map(|(id, owner, name)| ((id, owner), name))
        .collect();
    Ok((
        rows.into_iter()
            .filter_map(|r| {
                let agent_id = source_agent_id(&r);
                let is_agent = agent_id.is_some();
                let default_agent =
                    agent_id.as_deref() == Some(format!("cloud-agent:{}", r.4).as_str());
                let sender_name = match &agent_id {
                    Some(_) if default_agent => r.10.clone().unwrap_or_else(|| "Agent".into()),
                    Some(id) => names
                        .get(&(id.clone(), r.4.clone()))
                        .cloned()
                        .unwrap_or_else(|| "Agent".into()),
                    None => r.5.clone(),
                };
                let agent_owner_name = agent_id.as_ref().map(|_| r.5.clone());
                let agent_avatar_url = if default_agent { r.11 } else { None };
                let agent_id = agent_id
                    .filter(|id| default_agent || names.contains_key(&(id.clone(), r.4.clone())));
                visible_text(&r.6).map(|text| Source {
                    id: r.0,
                    conversation_id: r.1,
                    session_id: r.2,
                    session_title: r.3,
                    sender_account_id: r.4,
                    sender_name,
                    text,
                    created_at: r.7.to_rfc3339(),
                    version: r.8,
                    is_agent,
                    agent_id,
                    agent_owner_name,
                    agent_avatar_url,
                })
            })
            .collect(),
        limited,
    ))
}

pub async fn sources(pool: &PgPool, account: &str, ids: Option<&[String]>) -> Result<Vec<Source>> {
    Ok(source_page(pool, account, ids).await?.0)
}

pub async fn authorized(pool: &PgPool, account: &str, ids: &[String]) -> Result<bool> {
    if ids.is_empty() {
        return Ok(true);
    }
    let found = sources(pool, account, Some(ids)).await?;
    Ok(ids.iter().all(|id| found.iter().any(|s| &s.id == id)))
}

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
    let retained: BTreeSet<_> = previous
        .as_ref()
        .into_iter()
        .flat_map(|p| {
            p.commitments
                .iter()
                .filter(|i| i.kind != "done")
                .flat_map(|i| i.source_ids.iter().cloned())
        })
        .collect();
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
        source.session_title = latest.session_title.clone();
        source.is_agent = latest.is_agent;
        source.agent_id = latest.agent_id.clone();
        source.agent_owner_name = latest.agent_owner_name.clone();
        source.agent_avatar_url = latest.agent_avatar_url.clone();
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
