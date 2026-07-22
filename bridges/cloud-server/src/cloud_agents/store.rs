use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agents::models::{
    clean_access_scope, clean_optional_text, clean_required_text, clean_string_list,
    CloudAgentDefinition, CloudAgentResource, CloudAgentSkill, CreateCloudAgentRequest,
    SharedCloudAgentSummary, UpdateCloudAgentRequest, CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
    CLOUD_AGENT_STATUS_ACTIVE, CLOUD_AGENT_STATUS_ARCHIVED,
};

const NAME_MAX_LEN: usize = 120;
const ROLE_MAX_LEN: usize = 160;
const DESCRIPTION_MAX_LEN: usize = 1_200;
const PROMPT_MAX_LEN: usize = 80_000;
const SOURCE_SUMMARY_MAX_LEN: usize = 4_000;
const BOUNDARY_MAX_ITEMS: usize = 12;
const BOUNDARY_MAX_LEN: usize = 240;
const RESOURCE_MAX_ITEMS: usize = 24;
const RESOURCE_VALUE_MAX_LEN: usize = 4_000;
const SKILL_MAX_ITEMS: usize = 12;
const SKILL_FIELD_MAX_LEN: usize = 240;
const SKILL_CONTENT_MAX_LEN: usize = 96_000;

#[derive(Debug)]
pub enum CloudAgentStoreError {
    Invalid(String),
    Database(sqlx_core::Error),
}

impl std::fmt::Display for CloudAgentStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Database(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for CloudAgentStoreError {}

impl From<sqlx_core::Error> for CloudAgentStoreError {
    fn from(value: sqlx_core::Error) -> Self {
        Self::Database(value)
    }
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339()
}

fn clean_resources(resources: Vec<CloudAgentResource>) -> Vec<CloudAgentResource> {
    resources
        .into_iter()
        .filter_map(|resource| {
            let kind = resource.kind.trim();
            let value = resource.value.trim();
            if kind.is_empty() || value.is_empty() {
                return None;
            }
            Some(CloudAgentResource {
                kind: kind.chars().take(40).collect(),
                value: value.chars().take(RESOURCE_VALUE_MAX_LEN).collect(),
                title: clean_optional_text(resource.title.as_deref(), SKILL_FIELD_MAX_LEN)
                    .ok()
                    .flatten(),
                summary: clean_optional_text(resource.summary.as_deref(), SOURCE_SUMMARY_MAX_LEN)
                    .ok()
                    .flatten(),
            })
        })
        .take(RESOURCE_MAX_ITEMS)
        .collect()
}

fn clean_skills(skills: Vec<CloudAgentSkill>) -> Vec<CloudAgentSkill> {
    let mut cleaned = Vec::new();
    for skill in skills {
        let name = skill.name.trim();
        let description = skill.description.trim();
        if name.is_empty()
            || description.is_empty()
            || cleaned
                .iter()
                .any(|entry: &CloudAgentSkill| entry.name == name)
        {
            continue;
        }
        cleaned.push(CloudAgentSkill {
            name: name.chars().take(SKILL_FIELD_MAX_LEN).collect(),
            description: description.chars().take(SKILL_FIELD_MAX_LEN).collect(),
            content: clean_optional_text(skill.content.as_deref(), SKILL_CONTENT_MAX_LEN)
                .ok()
                .flatten(),
        });
        if cleaned.len() >= SKILL_MAX_ITEMS {
            break;
        }
    }
    cleaned
}

fn json_or_array<T: serde::Serialize>(
    value: &T,
) -> Result<serde_json::Value, CloudAgentStoreError> {
    serde_json::to_value(value).map_err(|err| CloudAgentStoreError::Invalid(err.to_string()))
}

type CloudAgentRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    serde_json::Value,
    serde_json::Value,
    serde_json::Value,
    serde_json::Value,
    String,
    String,
    Option<String>,
);

fn row_to_definition(row: CloudAgentRow) -> CloudAgentDefinition {
    CloudAgentDefinition {
        agent_id: row.0,
        owner_account_id: row.1,
        access_scope: row.2,
        status: row.3,
        name: row.4,
        role: row.5,
        description: row.6,
        system_prompt: row.7,
        source_summary: row.8,
        boundaries: serde_json::from_value(row.9).unwrap_or_default(),
        resources: serde_json::from_value(row.10).unwrap_or_default(),
        skills: serde_json::from_value(row.11).unwrap_or_default(),
        model_routing: row.12,
        created_at: row.13,
        updated_at: row.14,
        archived_at: row.15,
    }
}

async fn insert_agent_sync_event(
    pool: &PgPool,
    account_id: &str,
    event_type: &str,
    agent: &CloudAgentDefinition,
    now: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_sync_events
         (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at)
         VALUES ($1, $2, NULL, NULL, $3, $4)",
    )
    .bind(account_id)
    .bind(event_type)
    .bind(serde_json::json!({ "agent": agent }))
    .bind(timestamp(now))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn create_agent_definition(
    pool: &PgPool,
    owner_account_id: &str,
    input: CreateCloudAgentRequest,
    now: DateTime<Utc>,
) -> Result<CloudAgentDefinition, CloudAgentStoreError> {
    let access_scope =
        clean_access_scope(input.access_scope.as_deref()).map_err(CloudAgentStoreError::Invalid)?;
    let name = clean_required_text(&input.name, "name", NAME_MAX_LEN)
        .map_err(CloudAgentStoreError::Invalid)?;
    let role = clean_required_text(&input.role, "role", ROLE_MAX_LEN)
        .map_err(CloudAgentStoreError::Invalid)?;
    let system_prompt = clean_required_text(&input.system_prompt, "systemPrompt", PROMPT_MAX_LEN)
        .map_err(CloudAgentStoreError::Invalid)?;
    let description = clean_optional_text(input.description.as_deref(), DESCRIPTION_MAX_LEN)
        .map_err(CloudAgentStoreError::Invalid)?;
    let source_summary =
        clean_optional_text(input.source_summary.as_deref(), SOURCE_SUMMARY_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    let boundaries = clean_string_list(input.boundaries, BOUNDARY_MAX_ITEMS, BOUNDARY_MAX_LEN);
    let resources = clean_resources(input.resources);
    let skills = clean_skills(input.skills);
    let model_routing = input.model_routing.unwrap_or_else(|| serde_json::json!({}));
    let now_text = timestamp(now);
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());

    let row = query_as::<_, CloudAgentRow>(
        "INSERT INTO cloud_agent_definitions (
             agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at
         ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at",
    )
    .bind(&agent_id)
    .bind(owner_account_id)
    .bind(&access_scope)
    .bind(&name)
    .bind(&role)
    .bind(&description)
    .bind(&system_prompt)
    .bind(&source_summary)
    .bind(json_or_array(&boundaries)?)
    .bind(json_or_array(&resources)?)
    .bind(json_or_array(&skills)?)
    .bind(model_routing)
    .bind(&now_text)
    .fetch_one(pool)
    .await?;
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        pool,
        owner_account_id,
        "agent.definition.upserted",
        &agent,
        now,
    )
    .await?;
    Ok(agent)
}

pub async fn list_agent_definitions(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<CloudAgentDefinition>, CloudAgentStoreError> {
    let rows = query_as::<_, CloudAgentRow>(
        "SELECT agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at
         FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND status = 'active'
         ORDER BY updated_at DESC, agent_id ASC",
    )
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_definition).collect())
}

pub async fn list_shared_agent_summaries(
    pool: &PgPool,
    owner_account_ids: &[String],
) -> Result<Vec<SharedCloudAgentSummary>, CloudAgentStoreError> {
    let owners: Vec<String> = owner_account_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(50)
        .collect();
    if owners.is_empty() {
        return Ok(Vec::new());
    }

    let rows = query_as::<_, (String, String, Option<String>, String, String, String, Option<String>, String)>(
        "SELECT a.agent_id, a.owner_account_id, c.display_name, a.access_scope, a.name, a.role, a.description, a.updated_at
         FROM cloud_agent_definitions a
         LEFT JOIN cloud_accounts c ON c.account_id = a.owner_account_id
         WHERE a.owner_account_id = ANY($1)
           AND a.status = $2
           AND a.access_scope = $3
         ORDER BY a.updated_at DESC, a.agent_id ASC",
    )
    .bind(&owners)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .bind(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SharedCloudAgentSummary {
            agent_id: row.0,
            owner_account_id: row.1,
            owner_display_name: row.2,
            access_scope: row.3,
            name: row.4,
            role: row.5,
            description: row.6,
            updated_at: row.7,
        })
        .collect())
}

pub async fn update_agent_definition(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    input: UpdateCloudAgentRequest,
    now: DateTime<Utc>,
) -> Result<Option<CloudAgentDefinition>, CloudAgentStoreError> {
    let Some(mut current) = get_agent_definition(pool, owner_account_id, agent_id).await? else {
        return Ok(None);
    };
    if current.status == CLOUD_AGENT_STATUS_ARCHIVED {
        return Ok(None);
    }

    if let Some(value) = input.access_scope {
        current.access_scope =
            clean_access_scope(Some(&value)).map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.name {
        current.name = clean_required_text(&value, "name", NAME_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.role {
        current.role = clean_required_text(&value, "role", ROLE_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.description {
        current.description = clean_optional_text(Some(&value), DESCRIPTION_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.system_prompt {
        current.system_prompt = clean_required_text(&value, "systemPrompt", PROMPT_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.source_summary {
        current.source_summary = clean_optional_text(Some(&value), SOURCE_SUMMARY_MAX_LEN)
            .map_err(CloudAgentStoreError::Invalid)?;
    }
    if let Some(value) = input.boundaries {
        current.boundaries = clean_string_list(value, BOUNDARY_MAX_ITEMS, BOUNDARY_MAX_LEN);
    }
    if let Some(value) = input.resources {
        current.resources = clean_resources(value);
    }
    if let Some(value) = input.skills {
        current.skills = clean_skills(value);
    }
    if let Some(value) = input.model_routing {
        current.model_routing = value;
    }

    let now_text = timestamp(now);
    let row = query_as::<_, CloudAgentRow>(
        "UPDATE cloud_agent_definitions
         SET access_scope = $4, name = $5, role = $6, description = $7, system_prompt = $8, source_summary = $9,
             boundaries_json = $10, resources_json = $11, skills_json = $12, model_routing_json = $13,
             updated_at = $14
         WHERE owner_account_id = $1 AND agent_id = $2 AND status = $3
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .bind(&current.access_scope)
    .bind(&current.name)
    .bind(&current.role)
    .bind(&current.description)
    .bind(&current.system_prompt)
    .bind(&current.source_summary)
    .bind(json_or_array(&current.boundaries)?)
    .bind(json_or_array(&current.resources)?)
    .bind(json_or_array(&current.skills)?)
    .bind(&current.model_routing)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        pool,
        owner_account_id,
        "agent.definition.upserted",
        &agent,
        now,
    )
    .await?;
    Ok(Some(agent))
}

pub async fn archive_agent_definition(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<CloudAgentDefinition>, CloudAgentStoreError> {
    let now_text = timestamp(now);
    let row = query_as::<_, CloudAgentRow>(
        "UPDATE cloud_agent_definitions
         SET status = $4, archived_at = $3, updated_at = $3
         WHERE owner_account_id = $1 AND agent_id = $2 AND status = 'active'
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .bind(&now_text)
    .bind(CLOUD_AGENT_STATUS_ARCHIVED)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        pool,
        owner_account_id,
        "agent.definition.archived",
        &agent,
        now,
    )
    .await?;
    Ok(Some(agent))
}

async fn get_agent_definition(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Option<CloudAgentDefinition>, CloudAgentStoreError> {
    let row = query_as::<_, CloudAgentRow>(
        "SELECT agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at
         FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND agent_id = $2",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(row_to_definition))
}
