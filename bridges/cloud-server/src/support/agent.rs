use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::Deserialize;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::auth::routes::ContactSummary;

use super::config::{PendingSupportConfig, SupportConfig, SupportConfigError};

const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";
const SUPPORT_SYSTEM_PROMPT: &str = r#"You are Kordi Support, the official help agent for Kordi.

Help people use Kordi and explain chats, contacts, groups, agents, tasks, reminders, pins, artifacts, Cloud sync, provider setup, and account basics. Accept product suggestions and restate them clearly. When a request needs a human maintainer, explain that the user can submit the support form in this contact.

Never reveal provider credentials, authentication material, private infrastructure details, or data outside this support conversation. Never claim that a ticket, email, or GitHub issue was created unless the product explicitly confirms it."#;

pub async fn bootstrap_support_agent(
    pool: &PgPool,
    pending: PendingSupportConfig,
) -> Result<SupportConfig, SupportConfigError> {
    let existing_by_email: Option<(String, String)> = query_as(
        "SELECT account_id, created_at FROM cloud_accounts WHERE LOWER(primary_email) = LOWER($1)",
    )
    .bind(&pending.owner_email)
    .fetch_optional(pool)
    .await?;

    let now = Utc::now().to_rfc3339();
    let (owner_account_id, contact_created_at) = if let Some(row) = existing_by_email {
        row
    } else {
        let row: (String, String) = query_as(
            "INSERT INTO cloud_accounts (
                 account_id, display_name, primary_email, avatar_url, created_at, updated_at
             ) VALUES ($1, $2, $3, NULL, $4, $4)
             ON CONFLICT (account_id) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 primary_email = COALESCE(cloud_accounts.primary_email, EXCLUDED.primary_email),
                 updated_at = EXCLUDED.updated_at
             RETURNING account_id, created_at",
        )
        .bind(&pending.owner_account_id)
        .bind(&pending.name)
        .bind(&pending.owner_email)
        .bind(&now)
        .fetch_one(pool)
        .await?;
        row
    };

    let config = SupportConfig {
        owner_account_id,
        owner_email: pending.owner_email,
        agent_id: pending.agent_id,
        name: pending.name,
        subtitle: pending.subtitle,
        inbox: pending.inbox,
        contact_created_at,
        default_model: pending.default_model,
        default_auth_provider: pending.default_auth_provider,
        default_auth_choice: pending.default_auth_choice,
    };

    let result = query(
        "INSERT INTO cloud_agent_definitions (
             agent_id, owner_account_id, access_scope, status, name, role, description,
             system_prompt, source_summary, boundaries_json, resources_json, skills_json,
             model_routing_json, created_at, updated_at, archived_at, is_system_managed
         ) VALUES (
             $1, $2, 'participant_conversations', 'active', $3, 'Official Kordi support agent',
             $4, $5, 'Official Kordi product guidance and feedback intake.', '[]', '[]', '[]',
             $6, $7, $7, NULL, TRUE
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
    .bind(&config.owner_account_id)
    .bind(&config.name)
    .bind(&config.subtitle)
    .bind(SUPPORT_SYSTEM_PROMPT)
    .bind(config.model_routing())
    .bind(&now)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(SupportConfigError::Invalid(
            "The configured support agent id belongs to another account",
        ));
    }

    Ok(config)
}

pub fn support_contact(config: &SupportConfig) -> ContactSummary {
    ContactSummary {
        contact_id: Some("cloud-system:kordi-support".to_string()),
        contact_kind: Some("system_agent".to_string()),
        account_id: config.owner_account_id.clone(),
        display_name: Some(config.name.clone()),
        subtitle: Some(config.subtitle.clone()),
        avatar_url: None,
        node_id: None,
        created_at: config.contact_created_at.clone(),
        locked: true,
        target_cloud_agent_id: Some(config.agent_id.clone()),
        target_cloud_agent_name: Some(config.name.clone()),
        target_cloud_agent_owner_account_id: Some(config.owner_account_id.clone()),
        target_cloud_agent_owner_name: Some("Kordi".to_string()),
        support_ticket_enabled: true,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectMessageEnvelope {
    schema_version: i64,
    kind: String,
    text: String,
    target_cloud_agent_id: Option<String>,
    target_cloud_agent_owner_account_id: Option<String>,
}

fn direct_message(body: &str) -> Option<DirectMessageEnvelope> {
    let encoded = body.trim().strip_prefix(CLOUD_DIRECT_MESSAGE_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub fn message_targets_support_agent(
    body: &str,
    peer_account_id: &str,
    config: &SupportConfig,
) -> Option<String> {
    let envelope = direct_message(body)?;
    let text = envelope.text.trim();
    (envelope.schema_version == 1
        && envelope.kind == "message"
        && !text.is_empty()
        && envelope.target_cloud_agent_id.as_deref() == Some(config.agent_id.as_str())
        && envelope.target_cloud_agent_owner_account_id.as_deref()
            == Some(config.owner_account_id.as_str())
        && peer_account_id == config.owner_account_id)
        .then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_target_requires_the_exact_agent_and_owner() {
        let config = SupportConfig {
            owner_account_id: "acct_support".into(),
            owner_email: "support@example.com".into(),
            agent_id: "cloud_agent_kordi_support".into(),
            name: "Kordi Support".into(),
            subtitle: "Ask questions".into(),
            inbox: "support@example.com".into(),
            contact_created_at: "2026-08-04T00:00:00Z".into(),
            default_model: None,
            default_auth_provider: None,
            default_auth_choice: None,
        };
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "kind": "message",
            "text": "How do groups work?",
            "targetCloudAgentId": config.agent_id,
            "targetCloudAgentOwnerAccountId": config.owner_account_id,
        });
        let body = format!(
            "{CLOUD_DIRECT_MESSAGE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        assert_eq!(
            message_targets_support_agent(&body, "acct_support", &config).as_deref(),
            Some("How do groups work?")
        );
        assert!(message_targets_support_agent(&body, "acct_other", &config).is_none());
    }
}
