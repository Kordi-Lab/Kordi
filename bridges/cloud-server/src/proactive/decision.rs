//! The owner's decision, and the run it starts.
//!
//! `allow` queues one ordinary owner-started group run that answers the
//! collaborator's message as the agent; `decline` records the decision and
//! posts nothing. The proposal then follows its run: `running` once a runner
//! holds it, `done` or `failed` when it ends. Every change appends the
//! `proactive.proposal_changed` hint for the owner in the same transaction.

use chrono::Utc;
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::prompt::{approved_prompt, group_system_prompt, AgentPersona, ApprovedRequest};
use super::APPROVED_RUN_PREFIX;
use crate::cloud_agent_runtime::runs::route_fill::fill_cloud_route;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;
use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Allow,
    Decline,
}

impl Choice {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "decline" => Some(Self::Decline),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum DecisionError {
    NotFound,
    Forbidden,
    /// Not pending, expired, or no longer allowed.
    Conflict,
    Database(sqlx_core::Error),
}

impl From<sqlx_core::Error> for DecisionError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

/// The approved run of `proposal_id`.
pub fn approved_run_id(proposal_id: &str) -> String {
    format!("{APPROVED_RUN_PREFIX}{proposal_id}")
}

pub(crate) use super::agents::agent_owner;

type PersonaRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Value,
    Value,
    Value,
);

/// Everything the approved run is built from.
struct RunPlan {
    prompt: String,
    system_prompt: String,
    route: Value,
    sandbox_id: String,
    prefer_desktop: bool,
}

/// The approved run's persona: `(owner name, system prompt, model routing)`.
/// A definition answers as its shared Cloud Agent; the default agent gets the
/// prompt every default Kordi group run gets.
async fn persona(
    pool: &PgPool,
    proposal: &super::proposal::Proposal,
) -> Result<Option<(String, String, Value)>, sqlx_core::Error> {
    if super::agents::default_owner(&proposal.agent_id) == Some(&proposal.owner_account_id) {
        let owner: Option<(Option<String>,)> =
            query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
                .bind(&proposal.owner_account_id)
                .fetch_optional(pool)
                .await?;
        let system_prompt = crate::cloud_agent_runtime::runs::prompt_history::default_system_prompt(
            Some(&proposal.session_id),
            None,
        );
        return Ok(owner.map(|(name,)| {
            let name = name.unwrap_or_else(|| "Owner".to_string());
            (name, system_prompt, Value::Null)
        }));
    }
    let persona: Option<PersonaRow> = query_as(
        "SELECT agent.name, owner.display_name, agent.system_prompt, agent.source_summary,
                agent.boundaries_json, agent.skills_json, agent.model_routing_json
         FROM cloud_agent_definitions agent
         JOIN cloud_accounts owner ON owner.account_id = agent.owner_account_id
         WHERE agent.agent_id = $1 AND agent.owner_account_id = $2 AND agent.status = 'active'",
    )
    .bind(&proposal.agent_id)
    .bind(&proposal.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(persona.map(
        |(name, owner_name, system_prompt, summary, boundaries, skills, routing)| {
            let owner_name = owner_name.unwrap_or_else(|| "Owner".to_string());
            let system_prompt = group_system_prompt(
                &AgentPersona {
                    name: &name,
                    owner_name: &owner_name,
                    system_prompt: &system_prompt,
                    source_summary: summary.as_deref(),
                    boundaries: &boundaries,
                    skills: &skills,
                },
                &proposal.session_id,
            );
            (owner_name, system_prompt, routing)
        },
    ))
}

async fn plan_run(
    pool: &PgPool,
    proposal: &super::proposal::Proposal,
) -> Result<Option<RunPlan>, sqlx_core::Error> {
    let Some((owner_name, system_prompt, routing)) = persona(pool, proposal).await? else {
        return Ok(None);
    };
    let snapshot: Option<(String,)> = query_as(
        "SELECT run.prompt FROM cloud_agent_proactive_proposals p
         JOIN cloud_agent_fallback_runs run ON run.run_id = p.evaluation_run_id
         WHERE p.proposal_id = $1",
    )
    .bind(&proposal.proposal_id)
    .fetch_optional(pool)
    .await?;
    let snapshot: Value = snapshot
        .and_then(|(prompt,)| serde_json::from_str(&prompt).ok())
        .unwrap_or(Value::Null);
    let evidence_ids: Option<(Value,)> = query_as(
        "SELECT evidence_json FROM cloud_agent_proactive_proposals WHERE proposal_id = $1",
    )
    .bind(&proposal.proposal_id)
    .fetch_optional(pool)
    .await?;
    let evidence_ids: Vec<String> = evidence_ids
        .and_then(|(value,)| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let messages: Vec<&Value> = snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let by_id = |id: &str| {
        messages
            .iter()
            .find(|message| message["messageId"].as_str() == Some(id))
            .copied()
    };
    let person_name = by_id(&proposal.trigger_message_id)
        .and_then(|message| message["senderName"].as_str())
        .unwrap_or("them")
        .to_string();
    let mut ids = evidence_ids;
    if !ids.contains(&proposal.trigger_message_id) {
        ids.push(proposal.trigger_message_id.clone());
    }
    let evidence: Vec<(String, String)> = messages
        .iter()
        .filter(|message| {
            message["messageId"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|wanted| wanted == id))
        })
        .map(|message| {
            (
                message["senderName"]
                    .as_str()
                    .unwrap_or("Member")
                    .to_string(),
                message["text"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let prompt = approved_prompt(&ApprovedRequest {
        owner_name: &owner_name,
        person_name: &person_name,
        problem: &proposal.problem,
        plan: &proposal.plan,
        evidence: &evidence,
    });
    let owner = &proposal.owner_account_id;
    let route = serde_json::from_value::<AgentRuntimeRoute>(routing).unwrap_or_default();
    let route = fill_cloud_route(pool, owner, &proposal.session_id, route).await?;
    let route =
        serde_json::to_value(route).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    let sandbox = ensure_sandbox_for_run(pool, &proposal.session_id, owner, owner).await?;
    // The owner's ready Mac goes first when it can run proactive runs and
    // this agent (see `desktop`); otherwise the cloud runner answers at once.
    let prefer_desktop =
        crate::cloud_agent_runtime::agent_desktop_ready(pool, owner, &proposal.agent_id).await?
            && crate::cloud_agent_runtime::agent_desktop_ready(pool, owner, super::CAPABILITY)
                .await?;
    Ok(Some(RunPlan {
        prompt,
        system_prompt,
        route,
        sandbox_id: sandbox.sandbox_id,
        prefer_desktop,
    }))
}

/// Applies the owner's decision. Only the owner decides, only once, and only
/// while the proposal is pending, unexpired, and the owner is still in the
/// group with the agent still watching.
pub async fn decide(
    pool: &PgPool,
    account_id: &str,
    agent_id: &str,
    proposal_id: &str,
    choice: Choice,
) -> Result<super::proposal::Proposal, DecisionError> {
    let Some(owner) = agent_owner(pool, agent_id).await? else {
        return Err(DecisionError::NotFound);
    };
    if owner != account_id {
        return Err(DecisionError::Forbidden);
    }
    let Some(proposal) = super::proposal::load(pool, proposal_id).await? else {
        return Err(DecisionError::NotFound);
    };
    if proposal.agent_id != agent_id {
        return Err(DecisionError::NotFound);
    }
    if proposal.owner_account_id != account_id {
        return Err(DecisionError::Forbidden);
    }
    if proposal.status != "pending" {
        return Err(DecisionError::Conflict);
    }
    let plan = match choice {
        Choice::Allow => plan_run(pool, &proposal).await?,
        Choice::Decline => None,
    };
    let mut tx = pool.begin().await?;
    let (pending, expired, allowed): (bool, bool, bool) = query_as(concat!(
        "SELECT p.status = 'pending', p.expires_at <= now(),
                EXISTS (SELECT 1 FROM ",
        super::agents::watchers_sql!(),
        " agent
                        JOIN cloud_chat_conversation_members member
                          ON member.account_id = agent.owner_account_id
                         AND member.conversation_id = p.conversation_id
                         AND member.membership_state = 'active'
                        WHERE agent.agent_id = p.agent_id)
         FROM cloud_agent_proactive_proposals p WHERE p.proposal_id = $1 FOR UPDATE OF p"
    ))
    .bind(proposal_id)
    .fetch_one(&mut *tx)
    .await?;
    if !pending {
        return Err(DecisionError::Conflict);
    }
    if expired || !allowed {
        query(
            "UPDATE cloud_agent_proactive_proposals SET status = 'expired' WHERE proposal_id = $1",
        )
        .bind(proposal_id)
        .execute(&mut *tx)
        .await?;
        super::proposal::hint(&mut tx, &[proposal_id.to_string()]).await?;
        tx.commit().await?;
        return Err(DecisionError::Conflict);
    }
    match (choice, plan) {
        (Choice::Decline, _) => {
            query(
                "UPDATE cloud_agent_proactive_proposals
                 SET status = 'declined', decided_at = now() WHERE proposal_id = $1",
            )
            .bind(proposal_id)
            .execute(&mut *tx)
            .await?;
        }
        (Choice::Allow, None) => return Err(DecisionError::Conflict),
        (Choice::Allow, Some(plan)) => {
            let run_id = approved_run_id(proposal_id);
            let now = Utc::now().to_rfc3339();
            let preferred_until = plan
                .prefer_desktop
                .then(|| Utc::now() + crate::presence::presence_timeout());
            let inserted = query(
                "INSERT INTO cloud_agent_fallback_runs (
                     run_id, idempotency_key, request_message_id, session_id, owner_account_id,
                     requester_account_id, status, prompt, system_prompt, sandbox_id,
                     runtime_route_json, created_at, updated_at, execution_backend,
                     execution_agent_id, run_trigger, connector_audience, desktop_preferred_until
                 ) VALUES ($1, $1, $2, $3, $4, $4, 'queued', $5, $6, $7, $8, $9, $9, 'cloud',
                           $10, 'person_started', 'shared', $11)
                 ON CONFLICT DO NOTHING",
            )
            .bind(&run_id)
            .bind(&proposal.trigger_message_id)
            .bind(&proposal.session_id)
            .bind(&proposal.owner_account_id)
            .bind(&plan.prompt)
            .bind(&plan.system_prompt)
            .bind(&plan.sandbox_id)
            .bind(&plan.route)
            .bind(&now)
            .bind(&proposal.agent_id)
            .bind(preferred_until)
            .execute(&mut *tx)
            .await?;
            // Another run of this agent already answers the same message.
            if inserted.rows_affected() == 0 {
                return Err(DecisionError::Conflict);
            }
            query(
                "UPDATE cloud_agent_proactive_proposals
                 SET status = 'approved', decided_at = now(), run_id = $2
                 WHERE proposal_id = $1",
            )
            .bind(proposal_id)
            .bind(&run_id)
            .execute(&mut *tx)
            .await?;
            if plan.prefer_desktop {
                let payload = serde_json::json!({
                    "runId": run_id,
                    "sessionId": proposal.session_id,
                    "agentId": proposal.agent_id,
                    "proposalId": proposal_id,
                });
                crate::chat_sync::store::append_account_hint(
                    &mut tx,
                    &proposal.owner_account_id,
                    "proactive.run_requested",
                    &payload,
                )
                .await
                .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
            }
        }
    }
    super::proposal::hint(&mut tx, &[proposal_id.to_string()]).await?;
    tx.commit().await?;
    super::proposal::load(pool, proposal_id)
        .await?
        .ok_or(DecisionError::NotFound)
}

/// Moves approved proposals along with their runs (all of them, or the one
/// behind `run_id`) and expires pending proposals whose time ran out, with a
/// hint for each change. Returns how many proposals changed.
pub async fn sync_runs(pool: &PgPool, run_id: Option<&str>) -> Result<usize, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let moved: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_proactive_proposals p
         SET status = CASE
             WHEN run.status = 'completed' THEN 'done'
             WHEN run.status IN ('failed', 'cancelled') THEN 'failed'
             ELSE 'running' END
         FROM cloud_agent_fallback_runs run
         WHERE run.run_id = p.run_id AND p.status IN ('approved', 'running')
           AND ($1::text IS NULL OR p.run_id = $1)
           AND (run.status IN ('completed', 'failed', 'cancelled')
             OR (p.status = 'approved' AND run.status IN ('leased', 'running')))
         RETURNING p.proposal_id",
    )
    .bind(run_id)
    .fetch_all(&mut *tx)
    .await?;
    let moved: Vec<String> = moved.into_iter().map(|(id,)| id).collect();
    super::proposal::hint(&mut tx, &moved).await?;
    let mut changed = moved.len();
    if run_id.is_none() {
        changed += super::proposal::expire_due(&mut tx, None).await?.len();
    }
    tx.commit().await?;
    Ok(changed)
}

/// The agent an approved run answers as, so group delivery names it as the
/// sender: `(agent_id, name)`. `None` for every other run.
pub async fn reply_agent(
    pool: &PgPool,
    run_id: &str,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    if !run_id.starts_with(APPROVED_RUN_PREFIX) {
        return Ok(None);
    }
    // The run's agent: a definition, or the owner's default agent.
    query_as(concat!(
        "SELECT run.execution_agent_id, COALESCE(agent.name, ",
        super::agents::default_name_sql!("owner", "profile"),
        ")
         FROM cloud_agent_fallback_runs run
         JOIN cloud_agent_proactive_proposals p ON p.run_id = run.run_id
         JOIN cloud_accounts owner ON owner.account_id = run.owner_account_id
         LEFT JOIN cloud_default_agent_profiles profile
           ON profile.owner_account_id = run.owner_account_id
         LEFT JOIN cloud_agent_definitions agent ON agent.agent_id = run.execution_agent_id
         WHERE run.run_id = $1
           AND (agent.agent_id IS NOT NULL
             OR run.execution_agent_id = 'cloud-agent:' || run.owner_account_id)"
    ))
    .bind(run_id)
    .fetch_optional(pool)
    .await
}
