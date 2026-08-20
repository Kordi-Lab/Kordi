use super::*;

type StoredAccountAvatar = (Option<String>, String, String, String, String, i64, String);

pub(super) async fn resolve_oauth_account_avatar(
    pool: &PgPool,
    account_id: &str,
    provider_avatar_url: Option<&str>,
    now: &str,
) -> Result<(AvatarDescriptor, bool), sqlx_core::Error> {
    let existing: Option<StoredAccountAvatar> = query_as(
        "SELECT avatar_url, avatar_source, avatar_style, avatar_seed, avatar_renderer_version, \
                avatar_version, avatar_updated_at FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = existing {
        return Ok((
            descriptor_from_parts(
                "human".to_string(),
                account_id.to_string(),
                StoredAvatar {
                    source: row.1,
                    style: row.2,
                    seed: row.3,
                    renderer_version: row.4,
                    avatar_url: row.0,
                    version: row.5,
                    updated_at: row.6,
                },
            ),
            false,
        ));
    }
    let provider_avatar = provider_avatar_url
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok((
        AvatarDescriptor {
            entity_type: "human".to_string(),
            entity_id: account_id.to_string(),
            source: if provider_avatar.is_some() {
                "uploaded"
            } else {
                "generated"
            }
            .to_string(),
            style: HUMAN_AVATAR_STYLE.to_string(),
            seed: new_avatar_seed(),
            renderer_version: AVATAR_RENDERER_VERSION.to_string(),
            uploaded_asset: provider_avatar.map(ToString::to_string),
            version: 1,
            updated_at: now.to_string(),
        },
        true,
    ))
}
