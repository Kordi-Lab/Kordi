//! Agent Access (docs/contact-permissions.md#agent-access).
//!
//! Every agent has an Access setting, the owner's default Kordi agent
//! included: `participant_conversations` ("People in my chats can mention
//! it") or `private` ("Only me"). Factory agents keep it in
//! `cloud_agent_definitions.access_scope`; the default agent keeps it in
//! `cloud_default_agent_profiles.access_scope`, where a missing value (or a
//! missing row) means `participant_conversations`.
//!
//! Access combines with the per-person "Use my agent" switch
//! (`crate::contact_permissions`): another account may use an agent only
//! when both allow it. The owner is never refused. A refused request gets
//! the same private `403 agent_not_available` as the switch.

mod routes;
#[cfg(test)]
mod tests;

use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

pub(crate) use routes::{read_access, update_access};

pub(crate) const ACCESS_PRIVATE: &str = "private";
pub(crate) const ACCESS_PARTICIPANTS: &str = "participant_conversations";

/// The default agent's canonical id.
pub(crate) fn default_agent_id(owner: &str) -> String {
    format!("cloud-agent:{}", owner.trim())
}

/// SQL that is true when the agent in `agent` (an SQL expression) is one of
/// the default agent's ids for the account in `owner`.
fn default_agent_id_sql(owner: &str, agent: &str) -> String {
    format!(
        "({agent} = 'cloud-agent:' || {owner} OR {agent} = 'cloud-self:' || {owner} \
          OR {agent} = 'cloud-local-agent' OR {agent} LIKE 'local:_%')"
    )
}

/// SQL that is true unless the account in `owner` made its default agent
/// private.
pub(crate) fn default_agent_open_sql(owner: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM cloud_default_agent_profiles default_access \
                     WHERE default_access.owner_account_id = {owner} \
                       AND default_access.access_scope = 'private')"
    )
}

/// SQL that is true when the account in `subject` may use the default agent
/// of the account in `owner` under its Access.
pub(crate) fn default_agent_usable_sql(owner: &str, subject: &str) -> String {
    format!("({owner} = {subject} OR {})", default_agent_open_sql(owner))
}

/// SQL that is true when the Access of agent `agent` of `owner` lets
/// `subject` use it: always for the owner; for the default agent unless it
/// is private; for a Factory agent unless its definition is private. Agents
/// without a definition row keep the checks of their own path.
pub(crate) fn access_allows_sql(owner: &str, subject: &str, agent: &str) -> String {
    format!(
        "({owner} = {subject} OR CASE WHEN {is_default} THEN {default_open} \
          ELSE NOT EXISTS (SELECT 1 FROM cloud_agent_definitions access_definition \
                           WHERE access_definition.agent_id = {agent} \
                             AND access_definition.owner_account_id = {owner} \
                             AND access_definition.access_scope = 'private') END)",
        is_default = default_agent_id_sql(owner, agent),
        default_open = default_agent_open_sql(owner),
    )
}

/// The one rule every path applies: `subject` may use agent `agent` of
/// `owner` when the per-person switch and the agent's Access both allow it.
pub(crate) fn agent_usable_sql(owner: &str, subject: &str, agent: &str) -> String {
    format!(
        "({} AND {})",
        crate::contact_permissions::agent_allowed_sql(owner, subject),
        access_allows_sql(owner, subject, agent)
    )
}

/// Whether `subject` may use agent `agent_id` of `owner`.
pub(crate) async fn agent_usable<'e, E>(
    executor: E,
    owner: &str,
    subject: &str,
    agent_id: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let (owner, subject) = (owner.trim(), subject.trim());
    if owner == subject {
        return Ok(true);
    }
    let (usable,): (bool,) = query_as(&format!("SELECT {}", agent_usable_sql("$1", "$2", "$3")))
        .bind(owner)
        .bind(subject)
        .bind(agent_id.trim())
        .fetch_one(executor)
        .await?;
    Ok(usable)
}

/// Whether the run's requester may still use the run's agent.
pub(crate) async fn run_usable(pool: &PgPool, run_id: &str) -> sqlx_core::Result<bool> {
    let row: Option<(bool,)> = query_as(&format!(
        "SELECT {} FROM cloud_agent_fallback_runs run WHERE run.run_id = $1",
        agent_usable_sql(
            "run.owner_account_id",
            "run.requester_account_id",
            "run.execution_agent_id"
        )
    ))
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_none_or(|(usable,)| usable))
}

/// Takes the owner's Access lock: shared while admitting a run, exclusive
/// while saving Access. A run admitted while Access turns private is either
/// refused or seen and cancelled by the save.
async fn lock_owner(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    owner: &str,
    exclusive: bool,
) -> sqlx_core::Result<()> {
    let lock = if exclusive {
        "SELECT pg_advisory_xact_lock(hashtext('agent-access:' || $1))"
    } else {
        "SELECT pg_advisory_xact_lock_shared(hashtext('agent-access:' || $1))"
    };
    sqlx_core::query::query(lock)
        .bind(owner.trim())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Takes the per-person lock and the owner's Access lock, then answers
/// whether `subject` may use agent `agent_id` of `owner`. The owner needs no
/// lock.
pub(crate) async fn lock_and_check(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    owner: &str,
    subject: &str,
    agent_id: &str,
) -> sqlx_core::Result<bool> {
    if owner.trim() == subject.trim() {
        return Ok(true);
    }
    if !crate::contact_permissions::lock_and_check_agent(tx, owner, subject).await? {
        return Ok(false);
    }
    lock_owner(tx, owner, false).await?;
    agent_usable(&mut **tx, owner, subject, agent_id).await
}

/// The default agent's Access; `participant_conversations` when none is
/// stored.
pub(crate) async fn default_access(pool: &PgPool, owner: &str) -> sqlx_core::Result<String> {
    let row: Option<(Option<String>,)> = query_as(
        "SELECT access_scope FROM cloud_default_agent_profiles WHERE owner_account_id = $1",
    )
    .bind(owner.trim())
    .fetch_optional(pool)
    .await?;
    Ok(row
        .and_then(|(scope,)| scope)
        .unwrap_or_else(|| ACCESS_PARTICIPANTS.to_string()))
}

/// Stores the default agent's Access. Making it private ends other people's
/// waiting and running requests to it; their run ids are returned for the
/// generic refusal reply.
pub(crate) async fn save_default_access(
    pool: &PgPool,
    owner: &str,
    scope: &str,
) -> sqlx_core::Result<Vec<String>> {
    let mut tx = pool.begin().await?;
    lock_owner(&mut tx, owner, true).await?;
    sqlx_core::query::query(
        "UPDATE cloud_default_agent_profiles SET access_scope = $2 WHERE owner_account_id = $1",
    )
    .bind(owner.trim())
    .bind(scope)
    .execute(&mut *tx)
    .await?;
    let refused = if scope == ACCESS_PRIVATE {
        stop_others(&mut tx, owner, None).await?
    } else {
        Vec::new()
    };
    tx.commit().await?;
    Ok(refused)
}

/// Ends other people's requests to a Factory agent that is now private.
/// Runs after the definition is saved: the exclusive lock waits for any
/// admission that saw the old Access, and the cancel then reaches its run.
pub(crate) async fn stop_others_for_definition(
    pool: &PgPool,
    owner: &str,
    agent_id: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    lock_owner(&mut tx, owner, true).await?;
    let refused = stop_others(&mut tx, owner, Some(agent_id)).await?;
    tx.commit().await?;
    for run_id in refused {
        crate::contact_permissions::publish_refusal(pool, &run_id).await;
    }
    Ok(())
}

/// Cancels the waiting and running requests other accounts made to the
/// owner's default agent (`agent_id` None) or to one Factory agent.
async fn stop_others(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    owner: &str,
    agent_id: Option<&str>,
) -> sqlx_core::Result<Vec<String>> {
    let target = match agent_id {
        Some(_) => "run.execution_agent_id = $2".to_string(),
        None => default_agent_id_sql("run.owner_account_id", "run.execution_agent_id"),
    };
    let statement = format!(
        "UPDATE cloud_agent_fallback_runs run
         SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, now()),
             completed_at = now()::text, updated_at = now()::text
         WHERE run.owner_account_id = $1 AND run.requester_account_id <> $1
           AND run.status IN ('queued', 'leased', 'running') AND {target}
         RETURNING run.run_id"
    );
    let mut update = query_as::<_, (String,)>(&statement).bind(owner.trim());
    if let Some(agent_id) = agent_id {
        update = update.bind(agent_id);
    }
    let rows = update.fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().map(|(run_id,)| run_id).collect())
}
