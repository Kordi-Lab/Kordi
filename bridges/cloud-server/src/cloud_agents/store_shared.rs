//! The agents other accounts can see: shared agents of the owners they ask
//! about.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::avatars::{descriptor_from_parts, StoredAvatar};
use crate::cloud_agents::models::{
    SharedCloudAgentSummary, CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
    CLOUD_AGENT_STATUS_ACTIVE,
};
use crate::cloud_agents::store::CloudAgentStoreError;
use crate::proactive::ProactiveSetting;

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
        serde_json::Value,
    );
    let rows = query_as::<_, SharedAgentRow>(
        "SELECT a.agent_id, a.owner_account_id, c.display_name, a.access_scope, a.name, a.role, a.description, a.updated_at,
             a.avatar_url, a.avatar_source, a.avatar_style, a.avatar_seed, a.avatar_renderer_version,
             a.avatar_version, a.avatar_updated_at, a.proactive_json
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
                proactive: ProactiveSetting::from_stored(&row.15),
                updated_at: row.7,
            }
        })
        .collect())
}
