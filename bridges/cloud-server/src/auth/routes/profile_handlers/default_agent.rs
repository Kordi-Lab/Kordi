use super::*;

pub(super) fn clean_default_agent_display_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(120).collect())
}

pub(super) async fn materialize_default_agent_avatar_mutation(
    state: &Arc<ServerState>,
    account_id: &str,
    mutation: &mut Option<AvatarMutationRequest>,
) -> Result<(), Box<Response>> {
    let Some(mutation) = mutation.as_mut() else {
        return Ok(());
    };
    crate::avatars::assets::materialize_legacy_avatar_mutation(
        state.db_pool(),
        state.s3(),
        account_id,
        "agent",
        &default_agent_id(account_id),
        mutation,
    )
    .await
    .map_err(|error| match error {
        crate::avatars::assets::AvatarAssetError::Invalid(message) => {
            boxed_err("invalid_avatar", message, StatusCode::BAD_REQUEST)
        }
        _ => boxed_err(
            "avatar_storage_unavailable",
            "Avatar storage is unavailable.",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    })
}

pub(super) async fn update_default_agent_profile(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    display_name: Option<&str>,
    mutation: Option<&AvatarMutationRequest>,
    now: &str,
) -> Result<DefaultAgentProfileRow, Box<Response>> {
    let current: Option<DefaultAgentProfileRow> = query_as(
        "SELECT owner_account_id, display_name, avatar_url, avatar_source, avatar_style, \
            avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at \
         FROM cloud_default_agent_profiles WHERE owner_account_id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| agent_profile_error())?;
    let current = current.ok_or_else(|| {
        boxed_err(
            "account_missing",
            "Default agent profile is unavailable.",
            StatusCode::NOT_FOUND,
        )
    })?;
    let current_avatar = default_agent_profile_from_row(account_id, Some(current), now).avatar;
    let next_avatar = match mutation {
        Some(mutation) if mutation.expected_version.is_none() => {
            return Err(boxed_err(
                "invalid_avatar_version",
                "Refresh the agent profile before changing its avatar.",
                StatusCode::BAD_REQUEST,
            ));
        }
        Some(mutation) => {
            preserve_avatar_render_key(tx, &current_avatar)
                .await
                .map_err(|_| {
                    boxed_err(
                        "server_error",
                        "Could not preserve agent avatar history.",
                        StatusCode::INTERNAL_SERVER_ERROR,
                    )
                })?;
            let next =
                apply_avatar_mutation(&current_avatar, mutation, now).map_err(
                    |error| match error {
                        AvatarMutationError::Conflict => boxed_err(
                            "avatar_conflict",
                            "Agent avatar changed on another device. Refresh and try again.",
                            StatusCode::CONFLICT,
                        ),
                        AvatarMutationError::Invalid(message) => {
                            boxed_err("invalid_avatar", message, StatusCode::BAD_REQUEST)
                        }
                    },
                )?;
            if mutation.action.trim() == "upload"
                && crate::avatars::assets::parse_uploaded_avatar_marker(
                    next.uploaded_asset.as_deref().unwrap_or_default(),
                )
                .is_some()
            {
                crate::avatars::assets::activate_avatar_asset(
                    tx,
                    account_id,
                    "agent",
                    &default_agent_id(account_id),
                    next.uploaded_asset.as_deref().unwrap_or_default(),
                )
                .await
                .map_err(|error| Box::new(avatar_activation_error(error)))?;
            }
            next
        }
        None => current_avatar,
    };
    let updated: Option<DefaultAgentProfileRow> = query_as(
        "UPDATE cloud_default_agent_profiles SET display_name = COALESCE($1, display_name), \
            avatar_url = $2, avatar_source = $3, avatar_style = $4, avatar_seed = $5, \
            avatar_renderer_version = $6, avatar_version = $7, avatar_updated_at = $8, updated_at = $8 \
         WHERE owner_account_id = $9 \
         RETURNING owner_account_id, display_name, avatar_url, avatar_source, avatar_style, \
            avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
    )
    .bind(display_name)
    .bind(next_avatar.image_url())
    .bind(&next_avatar.source)
    .bind(&next_avatar.style)
    .bind(&next_avatar.seed)
    .bind(&next_avatar.renderer_version)
    .bind(next_avatar.version)
    .bind(now)
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| agent_profile_error())?;
    updated.ok_or_else(|| {
        boxed_err(
            "account_missing",
            "Default agent profile is unavailable.",
            StatusCode::NOT_FOUND,
        )
    })
}

fn agent_profile_error() -> Box<Response> {
    boxed_err(
        "server_error",
        "Could not update agent profile.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}
