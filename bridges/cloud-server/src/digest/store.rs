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

fn is_agent_content(content: &Value) -> bool {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    content
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    return false;
                };
                if text.starts_with("kordi-cloud-agent-response:") {
                    return true;
                }
                text.strip_prefix("kordi-cloud-group:")
                    .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .is_some_and(|v| {
                        v.pointer("/message/senderKind").and_then(Value::as_str) == Some("agent")
                    })
            })
        })
}

async fn source_page(
    pool: &PgPool,
    account: &str,
    ids: Option<&[String]>,
) -> Result<(Vec<Source>, bool)> {
    let suffix = if ids.is_some() {
        " AND m.message_id::text=ANY($2) ORDER BY m.created_at DESC LIMIT 700"
    } else {
        " AND (m.generation_status IS NULL OR m.generation_status IN ('complete','completed')) ORDER BY m.created_at DESC LIMIT 501"
    };
    let sql=format!("SELECT m.message_id::text,c.conversation_id::text,COALESCE(c.legacy_session_id,c.conversation_id::text),COALESCE(member.personal_title,c.shared_title,c.group_title,'Conversation'),m.sender_account_id,COALESCE(sender.display_name,'Contact'),m.content,m.created_at,m.version,m.message_kind{SOURCE_FROM}{suffix}");
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
    );
    let mut request = query_as::<_, Row>(&sql).bind(account);
    if let Some(ids) = ids {
        request = request.bind(ids);
    }
    let rows = request.fetch_all(pool).await?;
    let limited = ids.is_none() && rows.len() > 500;
    Ok((
        rows.into_iter()
            .filter_map(|r| {
                visible_text(&r.6).map(|text| Source {
                    id: r.0,
                    conversation_id: r.1,
                    session_id: r.2,
                    session_title: r.3,
                    sender_account_id: r.4,
                    sender_name: if is_agent_content(&r.6) || r.9 == "assistant" {
                        format!("Agent for {}", r.5)
                    } else {
                        r.5
                    },
                    text,
                    created_at: r.7.to_rfc3339(),
                    version: r.8,
                    is_agent: is_agent_content(&r.6) || r.9 == "assistant",
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

pub async fn calendar(pool: &PgPool, account: &str) -> Result<Vec<CalendarEvent>> {
    let rows:Vec<(Value,i64)>=query_as("SELECT payload,revision FROM cloud_calendar_events WHERE account_id=$1 ORDER BY payload->>'startAt' LIMIT 1000").bind(account).fetch_all(pool).await?;
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
    })
}

fn input_hash(input: &Input) -> String {
    let value = json!({"version":1,"sources":input.sources,"events":input.calendar_events,"tasks":input.existing_tasks,"locale":input.locale,"timezone":input.timezone,"dueReminders":input.calendar_events.iter().filter(|e|e.reminder_at.as_ref().and_then(|d|chrono::DateTime::parse_from_rfc3339(d).ok()).is_some_and(|d|d<=Utc::now())).map(|e|&e.id).collect::<Vec<_>>()});
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

pub async fn refresh(pool: &PgPool, account: &str, force: bool) -> Result<()> {
    type DigestState = (String, String, String, Option<Value>, Option<String>);
    let row:Option<DigestState>=query_as("SELECT locale,timezone,input_hash,snapshot_json,active_run_id FROM cloud_account_digests WHERE account_id=$1 AND retry_after<=now()").bind(account).fetch_optional(pool).await?;
    let Some((locale, timezone, old_hash, snapshot, active)) = row else {
        return Ok(());
    };
    if active.is_some() {
        return Ok(());
    }
    let previous = snapshot.and_then(|v| serde_json::from_value(v).ok());
    let input = input(pool, account, &locale, &timezone, previous).await?;
    let hash = input_hash(&input);
    if hash == old_hash && !force {
        return Ok(());
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
    let changed=query("UPDATE cloud_account_digests SET active_run_id=$2,input_hash=$3,input_json=$4,error_code=NULL WHERE account_id=$1 AND active_run_id IS NULL AND (input_hash<>$3 OR $5)")
        .bind(account).bind(&run).bind(&hash).bind(serde_json::to_value(&input).unwrap()).bind(force).execute(&mut *tx).await?;
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
    let ids: Vec<_> = input.sources.iter().map(|s| s.id.clone()).collect();
    let current = sources(pool, account, Some(&ids)).await?;
    let versions: HashMap<_, _> = current.into_iter().map(|s| (s.id, s.version)).collect();
    if !input
        .sources
        .iter()
        .all(|s| versions.get(&s.id) == Some(&s.version))
    {
        return Ok(false);
    }
    for event in &input.calendar_events {
        if !authorized(pool, account, &event.source_ids).await? {
            return Ok(false);
        }
    }
    Ok(true)
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
