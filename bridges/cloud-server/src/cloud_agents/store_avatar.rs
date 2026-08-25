use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use crate::avatars::AvatarMutationRequest;
use crate::cloud_agents::store::CloudAgentStoreError;

pub(super) async fn activate_agent_avatar_reference(
    transaction: &mut Transaction<'_, Postgres>,
    owner_account_id: &str,
    agent_id: &str,
    mutation: Option<&AvatarMutationRequest>,
    avatar_url: &str,
) -> Result<(), CloudAgentStoreError> {
    if mutation.is_none_or(|value| value.action.trim() != "upload")
        || crate::avatars::assets::parse_uploaded_avatar_marker(avatar_url).is_none()
    {
        return Ok(());
    }
    crate::avatars::assets::activate_avatar_asset(
        transaction,
        owner_account_id,
        "agent",
        agent_id,
        avatar_url,
    )
    .await
    .map_err(map_avatar_asset_error)
}

fn map_avatar_asset_error(error: crate::avatars::assets::AvatarAssetError) -> CloudAgentStoreError {
    match error {
        crate::avatars::assets::AvatarAssetError::Database(error) => {
            CloudAgentStoreError::Database(error)
        }
        crate::avatars::assets::AvatarAssetError::Invalid(message) => {
            CloudAgentStoreError::Invalid(message.to_string())
        }
        crate::avatars::assets::AvatarAssetError::Unavailable
        | crate::avatars::assets::AvatarAssetError::ObjectStore => {
            CloudAgentStoreError::Invalid("Avatar storage is unavailable.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_activation_database_errors_use_the_server_error_path() {
        let error = map_avatar_asset_error(crate::avatars::assets::AvatarAssetError::Database(
            sqlx_core::Error::PoolClosed,
        ));

        assert!(matches!(error, CloudAgentStoreError::Database(_)));
    }
}
