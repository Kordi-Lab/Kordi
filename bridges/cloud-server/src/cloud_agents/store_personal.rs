//! The `personalAgent` field of an agent definition
//! (docs/development/personal-agent.md). The setting lives in
//! `cloud_personal_agent_settings`, shared with the owner's default agent, so
//! [`crate::personal_agent::setting`] applies it the same way for both.

use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::models::{CloudAgentDefinition, CLOUD_AGENT_STATUS_ACTIVE};
use super::store::CloudAgentStoreError;
use super::store_rows::{agent_columns, row_to_definition, CloudAgentRow};
use crate::personal_agent::PersonalAgentSetting;

/// The setting a create or update request asks for; `None` when it names none.
pub(super) fn requested(
    value: Option<&serde_json::Value>,
) -> Result<Option<PersonalAgentSetting>, CloudAgentStoreError> {
    value
        .map(PersonalAgentSetting::parse)
        .transpose()
        .map_err(|message| CloudAgentStoreError::InvalidSetting("invalid_personal_agent", message))
}

/// Stores a requested setting in the definition's transaction and shows it
/// on `agent`, before the definition's sync event is written.
pub(super) async fn apply(
    transaction: &mut Transaction<'_, Postgres>,
    owner_account_id: &str,
    agent: &mut CloudAgentDefinition,
    requested: Option<PersonalAgentSetting>,
) -> Result<(), CloudAgentStoreError> {
    let Some(setting) = requested else {
        return Ok(());
    };
    crate::personal_agent::setting::store_in_transaction(
        transaction,
        owner_account_id,
        &agent.agent_id,
        setting,
    )
    .await?;
    agent.personal_agent = setting;
    Ok(())
}

/// Stores only an active definition's personal agent setting and publishes
/// the definition when it changed. `None` for an unknown or archived one.
pub async fn set_agent_personal(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
    setting: PersonalAgentSetting,
) -> Result<Option<PersonalAgentSetting>, CloudAgentStoreError> {
    let mut transaction = pool.begin().await?;
    let row = query_as::<_, CloudAgentRow>(concat!(
        "SELECT ",
        agent_columns!(),
        " FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = $3
           AND is_system_managed = FALSE
         FOR UPDATE"
    ))
    .bind(agent_id)
    .bind(owner_account_id)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut agent = row_to_definition(row);
    let was = crate::personal_agent::setting::store_in_transaction(
        &mut transaction,
        owner_account_id,
        agent_id,
        setting,
    )
    .await?;
    if was != setting {
        agent.personal_agent = setting;
        crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut transaction,
            &[owner_account_id.to_string()],
            "agent.definition.upserted",
            None,
            &serde_json::json!({ "agent": agent }),
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(Some(setting))
}
