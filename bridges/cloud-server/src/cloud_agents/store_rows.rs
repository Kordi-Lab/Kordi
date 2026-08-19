use sqlx_core::{from_row::FromRow, row::Row};
use sqlx_postgres::PgRow;

use crate::avatars::{descriptor_from_parts, StoredAvatar};
use crate::cloud_agents::models::CloudAgentDefinition;

pub(super) struct CloudAgentRow {
    agent_id: String,
    owner_account_id: String,
    access_scope: String,
    status: String,
    name: String,
    role: String,
    description: Option<String>,
    system_prompt: String,
    source_summary: Option<String>,
    boundaries_json: serde_json::Value,
    resources_json: serde_json::Value,
    skills_json: serde_json::Value,
    model_routing_json: serde_json::Value,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
    avatar_url: Option<String>,
    avatar_source: String,
    avatar_style: String,
    avatar_seed: String,
    avatar_renderer_version: String,
    avatar_version: i64,
    avatar_updated_at: String,
}

impl<'row> FromRow<'row, PgRow> for CloudAgentRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            agent_id: row.try_get("agent_id")?,
            owner_account_id: row.try_get("owner_account_id")?,
            access_scope: row.try_get("access_scope")?,
            status: row.try_get("status")?,
            name: row.try_get("name")?,
            role: row.try_get("role")?,
            description: row.try_get("description")?,
            system_prompt: row.try_get("system_prompt")?,
            source_summary: row.try_get("source_summary")?,
            boundaries_json: row.try_get("boundaries_json")?,
            resources_json: row.try_get("resources_json")?,
            skills_json: row.try_get("skills_json")?,
            model_routing_json: row.try_get("model_routing_json")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            archived_at: row.try_get("archived_at")?,
            avatar_url: row.try_get("avatar_url")?,
            avatar_source: row.try_get("avatar_source")?,
            avatar_style: row.try_get("avatar_style")?,
            avatar_seed: row.try_get("avatar_seed")?,
            avatar_renderer_version: row.try_get("avatar_renderer_version")?,
            avatar_version: row.try_get("avatar_version")?,
            avatar_updated_at: row.try_get("avatar_updated_at")?,
        })
    }
}

pub(super) fn row_to_definition(row: CloudAgentRow) -> CloudAgentDefinition {
    let avatar = descriptor_from_parts(
        "agent".to_string(),
        row.agent_id.clone(),
        StoredAvatar {
            source: row.avatar_source,
            style: row.avatar_style,
            seed: row.avatar_seed,
            renderer_version: row.avatar_renderer_version,
            avatar_url: row.avatar_url,
            version: row.avatar_version,
            updated_at: row.avatar_updated_at,
        },
    );
    CloudAgentDefinition {
        agent_id: row.agent_id,
        owner_account_id: row.owner_account_id,
        access_scope: row.access_scope,
        status: row.status,
        name: row.name,
        role: row.role,
        description: row.description,
        avatar_url: Some(avatar.image_url()),
        avatar,
        system_prompt: row.system_prompt,
        source_summary: row.source_summary,
        boundaries: serde_json::from_value(row.boundaries_json).unwrap_or_default(),
        resources: serde_json::from_value(row.resources_json).unwrap_or_default(),
        skills: serde_json::from_value(row.skills_json).unwrap_or_default(),
        model_routing: row.model_routing_json,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
    }
}
