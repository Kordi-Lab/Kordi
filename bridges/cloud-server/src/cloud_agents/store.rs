use chrono::{DateTime, Utc};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::avatars::{
    apply_avatar_mutation, descriptor_from_parts, new_avatar_seed, preserve_avatar_render_key,
    AvatarDescriptor, AvatarMutationError, StoredAvatar, AGENT_AVATAR_STYLE,
    AVATAR_RENDERER_VERSION,
};
use crate::cloud_agents::models::{
    clean_access_scope, clean_optional_text, clean_required_text, clean_string_list,
    CloudAgentDefinition, CreateCloudAgentRequest, SharedCloudAgentSummary,
    UpdateCloudAgentRequest, CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
    CLOUD_AGENT_STATUS_ACTIVE, CLOUD_AGENT_STATUS_ARCHIVED,
};
use crate::cloud_agents::store_cleaning::{
    clean_resources, clean_skills, json_or_array, timestamp,
};
use crate::cloud_agents::store_rows::{row_to_definition, CloudAgentRow};

const NAME_MAX_LEN: usize = 120;
const ROLE_MAX_LEN: usize = 160;
const DESCRIPTION_MAX_LEN: usize = 1_200;
const PROMPT_MAX_LEN: usize = 80_000;
const SOURCE_SUMMARY_MAX_LEN: usize = 4_000;
const BOUNDARY_MAX_ITEMS: usize = 12;
const BOUNDARY_MAX_LEN: usize = 240;

#[derive(Debug)]
pub enum CloudAgentStoreError {
    Invalid(String),
    AvatarConflict,
    Database(sqlx_core::Error),
    Sync(crate::chat_sync::store::StoreError),
}

impl std::fmt::Display for CloudAgentStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::AvatarConflict => write!(f, "avatar version conflict"),
            Self::Database(err) => write!(f, "{err}"),
            Self::Sync(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for CloudAgentStoreError {}

impl From<sqlx_core::Error> for CloudAgentStoreError {
    fn from(value: sqlx_core::Error) -> Self {
        Self::Database(value)
    }
}

impl From<crate::chat_sync::store::StoreError> for CloudAgentStoreError {
    fn from(value: crate::chat_sync::store::StoreError) -> Self {
        Self::Sync(value)
    }
}

async fn insert_agent_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    include_viewers: bool,
    event_type: &str,
    agent: &CloudAgentDefinition,
) -> Result<(), crate::chat_sync::store::StoreError> {
    crate::chat_sync::store::append_user_sync_events_in_transaction(
        transaction,
        &[account_id.to_string()],
        event_type,
        None,
        &serde_json::json!({ "agent": agent }),
    )
    .await?;
    if include_viewers {
        let recipients =
            crate::chat_sync::store::identity_sync_recipient_ids(transaction, account_id, true)
                .await?
                .into_iter()
                .filter(|recipient| recipient != account_id)
                .collect::<Vec<_>>();
        crate::chat_sync::store::append_user_sync_events_in_transaction(
            transaction,
            &recipients,
            "agent.directory.changed",
            None,
            &serde_json::json!({
                "ownerAccountId": account_id,
                "agentId": agent.agent_id,
            }),
        )
        .await?;
    }
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
    let initial_avatar = AvatarDescriptor {
        entity_type: "agent".to_string(),
        entity_id: agent_id.clone(),
        source: "generated".to_string(),
        style: AGENT_AVATAR_STYLE.to_string(),
        seed: new_avatar_seed(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 1,
        updated_at: now_text.clone(),
    };
    let avatar = match input.avatar_mutation.as_ref() {
        Some(mutation) => apply_avatar_mutation(&initial_avatar, mutation, &now_text).map_err(
            |error| match error {
                AvatarMutationError::Conflict => CloudAgentStoreError::AvatarConflict,
                AvatarMutationError::Invalid(message) => CloudAgentStoreError::Invalid(message),
            },
        )?,
        None => initial_avatar,
    };
    let avatar_url = avatar.image_url();
    let mut transaction = pool.begin().await?;

    let row = query_as::<_, CloudAgentRow>(
        "INSERT INTO cloud_agent_definitions (
             agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, avatar_url, avatar_source, avatar_style,
             avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at
         ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13,
             $14, $15, $16, $17, $18, $19, $20)
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, avatar_url, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
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
    .bind(&avatar_url)
    .bind(&avatar.source)
    .bind(&avatar.style)
    .bind(&avatar.seed)
    .bind(&avatar.renderer_version)
    .bind(avatar.version)
    .bind(&avatar.updated_at)
    .fetch_one(&mut *transaction)
    .await?;
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        &mut transaction,
        owner_account_id,
        access_scope == CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
        "agent.definition.upserted",
        &agent,
    )
    .await?;
    transaction.commit().await?;
    Ok(agent)
}

pub async fn list_agent_definitions(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<CloudAgentDefinition>, CloudAgentStoreError> {
    let rows = query_as::<_, CloudAgentRow>(
        "SELECT agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, avatar_url, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at
         FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND status = 'active' AND is_system_managed = FALSE
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

    type SharedAgentRow = (
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        i64,
        String,
    );
    let rows = query_as::<_, SharedAgentRow>(
        "SELECT a.agent_id, a.owner_account_id, c.display_name, a.access_scope, a.name, a.role, a.description, a.updated_at,
             a.avatar_url, a.avatar_source, a.avatar_style, a.avatar_seed, a.avatar_renderer_version,
             a.avatar_version, a.avatar_updated_at
         FROM cloud_agent_definitions a
         LEFT JOIN cloud_accounts c ON c.account_id = a.owner_account_id
         WHERE a.owner_account_id = ANY($1)
           AND a.status = $2
           AND a.access_scope = $3
           AND a.is_system_managed = FALSE
         ORDER BY a.updated_at DESC, a.agent_id ASC",
    )
    .bind(&owners)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .bind(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let avatar = descriptor_from_parts(
                "agent".to_string(),
                row.0.clone(),
                StoredAvatar {
                    source: row.9,
                    style: row.10,
                    seed: row.11,
                    renderer_version: row.12,
                    avatar_url: row.8,
                    version: row.13,
                    updated_at: row.14,
                },
            );
            SharedCloudAgentSummary {
                agent_id: row.0,
                owner_account_id: row.1,
                owner_display_name: row.2,
                access_scope: row.3,
                name: row.4,
                role: row.5,
                description: row.6,
                avatar_url: Some(avatar.image_url()),
                avatar,
                updated_at: row.7,
            }
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
    let mut transaction = pool.begin().await?;
    let Some(mut current) =
        get_agent_definition_in_transaction(&mut transaction, owner_account_id, agent_id).await?
    else {
        return Ok(None);
    };
    if current.status == CLOUD_AGENT_STATUS_ARCHIVED {
        return Ok(None);
    }
    let was_shared = current.access_scope == CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS;

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
    if let Some(mutation) = input.avatar_mutation.as_ref() {
        if mutation.expected_version.is_none() {
            return Err(CloudAgentStoreError::Invalid(
                "Refresh the Agent before changing its avatar.".to_string(),
            ));
        }
        preserve_avatar_render_key(&mut transaction, &current.avatar).await?;
        current.avatar = apply_avatar_mutation(&current.avatar, mutation, &now_text).map_err(
            |error| match error {
                AvatarMutationError::Conflict => CloudAgentStoreError::AvatarConflict,
                AvatarMutationError::Invalid(message) => CloudAgentStoreError::Invalid(message),
            },
        )?;
        current.avatar_url = Some(current.avatar.image_url());
    }
    let row = query_as::<_, CloudAgentRow>(
        "UPDATE cloud_agent_definitions
         SET access_scope = $4, name = $5, role = $6, description = $7, system_prompt = $8, source_summary = $9,
             boundaries_json = $10, resources_json = $11, skills_json = $12, model_routing_json = $13,
             updated_at = $14, avatar_url = $15, avatar_source = $16, avatar_style = $17,
             avatar_seed = $18, avatar_renderer_version = $19, avatar_version = $20,
             avatar_updated_at = $21
         WHERE owner_account_id = $1 AND agent_id = $2 AND status = $3
           AND is_system_managed = FALSE
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, avatar_url, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
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
    .bind(&current.avatar_url)
    .bind(&current.avatar.source)
    .bind(&current.avatar.style)
    .bind(&current.avatar.seed)
    .bind(&current.avatar.renderer_version)
    .bind(current.avatar.version)
    .bind(&current.avatar.updated_at)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        &mut transaction,
        owner_account_id,
        was_shared || agent.access_scope == CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
        "agent.definition.upserted",
        &agent,
    )
    .await?;
    transaction.commit().await?;
    Ok(Some(agent))
}

pub async fn archive_agent_definition(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<CloudAgentDefinition>, CloudAgentStoreError> {
    let now_text = timestamp(now);
    let mut transaction = pool.begin().await?;
    let row = query_as::<_, CloudAgentRow>(
        "UPDATE cloud_agent_definitions
         SET status = $4, archived_at = $3, updated_at = $3
         WHERE owner_account_id = $1 AND agent_id = $2 AND status = 'active'
           AND is_system_managed = FALSE
         RETURNING agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, avatar_url, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .bind(&now_text)
    .bind(CLOUD_AGENT_STATUS_ARCHIVED)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let agent = row_to_definition(row);
    insert_agent_sync_event(
        &mut transaction,
        owner_account_id,
        agent.access_scope == CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
        "agent.definition.archived",
        &agent,
    )
    .await?;
    transaction.commit().await?;
    Ok(Some(agent))
}

async fn get_agent_definition_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Option<CloudAgentDefinition>, CloudAgentStoreError> {
    let row = query_as::<_, CloudAgentRow>(
        "SELECT agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, avatar_url, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at
         FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND agent_id = $2 AND is_system_managed = FALSE
         FOR UPDATE",
    )
    .bind(owner_account_id)
    .bind(agent_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(row_to_definition))
}
