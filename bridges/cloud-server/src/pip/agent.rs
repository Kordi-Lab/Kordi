//! Provisioning for Pip's system account, agent definition and membership.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::avatars::{
    generated_avatar_marker, AGENT_AVATAR_STYLE, AVATAR_RENDERER_VERSION, HUMAN_AVATAR_STYLE,
};

use super::config::{PendingPipConfig, PipConfig, PipConfigError};
use super::prompt::PIP_SYSTEM_PROMPT;

/// Creates or refreshes Pip's account, default agent profile and agent
/// definition, then makes sure Pip sits in every existing group conversation.
pub async fn bootstrap_pip_agent(
    pool: &PgPool,
    pending: PendingPipConfig,
) -> Result<PipConfig, PipConfigError> {
    let now = Utc::now().to_rfc3339();
    // Accounts only accept the human generated style (database check
    // constraint); clients substitute Pip's own mark for this account id.
    let account_avatar_url = generated_avatar_marker(HUMAN_AVATAR_STYLE, &pending.account_id, 1);
    let agent_avatar_url = generated_avatar_marker(AGENT_AVATAR_STYLE, &pending.agent_id, 1);

    let existing_by_email: Option<(String,)> =
        query_as("SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = LOWER($1)")
            .bind(&pending.owner_email)
            .fetch_optional(pool)
            .await?;
    if let Some((account_id,)) = existing_by_email {
        if account_id != pending.account_id {
            return Err(PipConfigError::Invalid(
                "KORDI_PIP_OWNER_EMAIL already belongs to another account",
            ));
        }
    }

    query(
        "INSERT INTO cloud_accounts (
             account_id, display_name, primary_email, avatar_url, created_at, updated_at,
             avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version,
             avatar_updated_at
         ) VALUES ($1, $2, $3, $4, $5, $5, 'generated', $6, $1, $7, 1, $5)
         ON CONFLICT (account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             primary_email = COALESCE(cloud_accounts.primary_email, EXCLUDED.primary_email),
             updated_at = EXCLUDED.updated_at",
    )
    .bind(&pending.account_id)
    .bind(&pending.name)
    .bind(&pending.owner_email)
    .bind(&account_avatar_url)
    .bind(&now)
    .bind(HUMAN_AVATAR_STYLE)
    .bind(AVATAR_RENDERER_VERSION)
    .execute(pool)
    .await?;

    // Member listings join every member to a default agent profile, so Pip
    // needs one even though it never delegates to a personal agent.
    query(
        "INSERT INTO cloud_default_agent_profiles (
             owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
             avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
             created_at, updated_at
         ) VALUES ($1, $2, $3, 'generated', $4, $5, $6, 1, $7, $7, $7)
         ON CONFLICT (owner_account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(&pending.account_id)
    .bind(&pending.name)
    .bind(&agent_avatar_url)
    .bind(AGENT_AVATAR_STYLE)
    .bind(&pending.agent_id)
    .bind(AVATAR_RENDERER_VERSION)
    .bind(&now)
    .execute(pool)
    .await?;

    let config = PipConfig {
        account_id: pending.account_id,
        owner_email: pending.owner_email,
        agent_id: pending.agent_id,
        name: pending.name,
        subtitle: pending.subtitle,
        provider_auth: pending.provider_auth,
    };

    let result = query(
        "INSERT INTO cloud_agent_definitions (
             agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, is_system_managed,
             avatar_url, avatar_source, avatar_style, avatar_seed, avatar_renderer_version,
             avatar_version, avatar_updated_at
         ) VALUES (
             $1, $2, 'participant_conversations', 'active', $3, 'Built-in plan agent',
             $4, $5, 'Turns group plans into shared cards and keeps them honest.', '[]', '[]', '[]',
             $6, $7, $7, NULL, TRUE, $8, 'generated', $9, $1, $10, 1, $7
         )
         ON CONFLICT (agent_id) DO UPDATE SET
             owner_account_id = EXCLUDED.owner_account_id,
             access_scope = EXCLUDED.access_scope,
             status = 'active',
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             description = EXCLUDED.description,
             system_prompt = EXCLUDED.system_prompt,
             source_summary = EXCLUDED.source_summary,
             model_routing_json = EXCLUDED.model_routing_json,
             updated_at = EXCLUDED.updated_at,
             archived_at = NULL,
             is_system_managed = TRUE
         WHERE cloud_agent_definitions.is_system_managed = TRUE
            OR cloud_agent_definitions.owner_account_id = EXCLUDED.owner_account_id",
    )
    .bind(&config.agent_id)
    .bind(&config.account_id)
    .bind(&config.name)
    .bind(&config.subtitle)
    .bind(PIP_SYSTEM_PROMPT)
    .bind(config.model_routing())
    .bind(&now)
    .bind(&agent_avatar_url)
    .bind(AGENT_AVATAR_STYLE)
    .bind(AVATAR_RENDERER_VERSION)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(PipConfigError::Invalid(
            "The configured Pip agent id belongs to another account",
        ));
    }

    let joined = super::membership::join_all_groups(pool, &config.account_id).await?;
    if joined > 0 {
        println!("Pip joined {joined} existing group conversation(s)");
    }
    Ok(config)
}
