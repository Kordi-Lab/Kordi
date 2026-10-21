use super::*;

mod default_agent;
mod fields;
mod lookup;
use default_agent::*;
pub(super) use fields::double_option;
use fields::ProfileFieldChanges;
pub(super) use lookup::get_profile;

pub(super) async fn update_me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpdateProfileRequest>,
) -> Response {
    let field_changes = match ProfileFieldChanges::from_request(&req) {
        Ok(value) => value,
        Err(error) => return err(error.code, error.message, StatusCode::BAD_REQUEST),
    };
    let display_name = clean_profile_display_name(req.display_name.as_deref());
    let mut avatar_mutation = req.avatar_mutation;
    let agent_display_name = clean_default_agent_display_name(req.agent_display_name.as_deref());
    let mut agent_avatar_mutation = req.agent_avatar_mutation;
    let public_handle = match req.kordi_id.as_deref().map(normalize_public_handle) {
        None => None,
        Some(Ok(handle)) => Some(handle),
        Some(Err(InvalidPublicHandle)) => {
            return err(
                "invalid_kordi_id",
                INVALID_PUBLIC_HANDLE_MESSAGE,
                StatusCode::BAD_REQUEST,
            );
        }
    };
    let now_at = Utc::now();
    let now = now_at.to_rfc3339();
    let pool = state.db_pool();
    if let Some(mutation) = avatar_mutation.as_mut() {
        if let Err(error) = crate::avatars::assets::materialize_legacy_avatar_mutation(
            pool,
            state.s3(),
            &session.account_id,
            "human",
            &session.account_id,
            mutation,
        )
        .await
        {
            return match error {
                crate::avatars::assets::AvatarAssetError::Invalid(message) => {
                    err("invalid_avatar", message, StatusCode::BAD_REQUEST)
                }
                _ => err(
                    "avatar_storage_unavailable",
                    "Avatar storage is unavailable.",
                    StatusCode::SERVICE_UNAVAILABLE,
                ),
            };
        }
    }
    if let Err(response) = materialize_default_agent_avatar_mutation(
        &state,
        &session.account_id,
        &mut agent_avatar_mutation,
    )
    .await
    {
        return *response;
    }
    let mut tx = match pool.begin().await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not update profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let current: Option<StoredAvatarRow> = match query_as(
        "SELECT avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_url, avatar_version, avatar_updated_at \
         FROM cloud_accounts WHERE account_id = $1 FOR UPDATE",
    )
    .bind(&session.account_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Could not update profile.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some(current) = current else {
        return err(
            "account_missing",
            "Account no longer exists.",
            StatusCode::NOT_FOUND,
        );
    };
    let current_handle: (Option<String>, Option<DateTime<Utc>>) = match query_as(
        "SELECT public_handle, public_handle_changed_at FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(&session.account_id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not update profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    // Repeating the current handle (same case) is a no-op and never locks.
    let public_handle = public_handle.filter(|requested| *requested != current_handle.0);
    if public_handle.is_some() {
        if let Some(available_at) = current_handle
            .1
            .and_then(|changed_at| public_handle_locked_until(changed_at, now_at))
        {
            return err(
                "kordi_id_change_locked",
                public_handle_locked_message(available_at),
                StatusCode::CONFLICT,
            );
        }
    }
    let current_avatar = descriptor_from_parts(
        "human".to_string(),
        session.account_id.clone(),
        current.into(),
    );
    let next_avatar = match avatar_mutation.as_ref() {
        Some(mutation) if mutation.expected_version.is_none() => {
            return err(
                "invalid_avatar_version",
                "Refresh the profile before changing its avatar.",
                StatusCode::BAD_REQUEST,
            );
        }
        Some(mutation) => {
            if preserve_avatar_render_key(&mut tx, &current_avatar)
                .await
                .is_err()
            {
                return err(
                    "server_error",
                    "Could not preserve avatar history.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
            let next = match apply_avatar_mutation(&current_avatar, mutation, &now) {
                Ok(value) => value,
                Err(AvatarMutationError::Conflict) => {
                    return err(
                        "avatar_conflict",
                        "Avatar changed on another device. Refresh and try again.",
                        StatusCode::CONFLICT,
                    );
                }
                Err(AvatarMutationError::Invalid(message)) => {
                    return err("invalid_avatar", message, StatusCode::BAD_REQUEST);
                }
            };
            if mutation.action.trim() == "upload"
                && crate::avatars::assets::parse_uploaded_avatar_marker(
                    next.uploaded_asset.as_deref().unwrap_or_default(),
                )
                .is_some()
            {
                if let Err(error) = crate::avatars::assets::activate_avatar_asset(
                    &mut tx,
                    &session.account_id,
                    "human",
                    &session.account_id,
                    next.uploaded_asset.as_deref().unwrap_or_default(),
                )
                .await
                {
                    return avatar_activation_error(error);
                }
            }
            next
        }
        None => current_avatar,
    };
    let updated_agent_row = match update_default_agent_profile(
        &mut tx,
        &session.account_id,
        agent_display_name.as_deref(),
        agent_avatar_mutation.as_ref(),
        &now,
    )
    .await
    {
        Ok(row) => row,
        Err(response) => return *response,
    };
    let avatar_url = next_avatar.image_url();
    let ProfileFieldChanges {
        about,
        location,
        time_zone,
        website,
        birthday,
    } = field_changes;
    let row: Option<OwnerAccountRecordRow> = match query_as(&format!(
        "UPDATE cloud_accounts SET \
            display_name = COALESCE($1, display_name), avatar_url = $2, avatar_source = $3, \
            avatar_style = $4, avatar_seed = $5, avatar_renderer_version = $6, avatar_version = $7, \
            avatar_updated_at = $8, updated_at = $9, \
            public_handle = CASE WHEN $11::BOOLEAN THEN $12 ELSE public_handle END, \
            public_handle_changed_at = CASE WHEN $11::BOOLEAN THEN $13::TIMESTAMPTZ \
                ELSE public_handle_changed_at END, \
            about = CASE WHEN $14::BOOLEAN THEN $15 ELSE about END, \
            location = CASE WHEN $16::BOOLEAN THEN $17 ELSE location END, \
            time_zone = CASE WHEN $18::BOOLEAN THEN $19 ELSE time_zone END, \
            website = CASE WHEN $20::BOOLEAN THEN $21 ELSE website END, \
            birthday = CASE WHEN $22::BOOLEAN THEN $23::DATE ELSE birthday END \
         WHERE account_id = $10 \
         RETURNING {OWNER_ACCOUNT_RECORD_COLUMNS}",
    ))
    .bind(display_name.as_deref())
    .bind(&avatar_url)
    .bind(&next_avatar.source)
    .bind(&next_avatar.style)
    .bind(&next_avatar.seed)
    .bind(&next_avatar.renderer_version)
    .bind(next_avatar.version)
    .bind(&next_avatar.updated_at)
    .bind(&now)
    .bind(&session.account_id)
    .bind(public_handle.is_some())
    .bind(public_handle.clone().flatten())
    .bind(now_at)
    .bind(about.is_some())
    .bind(about.flatten())
    .bind(location.is_some())
    .bind(location.flatten())
    .bind(time_zone.is_some())
    .bind(time_zone.flatten())
    .bind(website.is_some())
    .bind(website.flatten())
    .bind(birthday.is_some())
    .bind(birthday.flatten())
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(error) if is_public_handle_taken(&error) => {
            return err(
                "kordi_id_taken",
                "That Kordi ID is already taken.",
                StatusCode::CONFLICT,
            );
        }
        Err(_) => return err("server_error", "Could not update profile.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some(row) = row else {
        return err(
            "account_missing",
            "Account no longer exists.",
            StatusCode::NOT_FOUND,
        );
    };
    let account = owner_account_response_from_rows(row, Some(updated_agent_row));
    let recipients = match crate::chat_sync::store::identity_sync_recipient_ids(
        &mut tx,
        &session.account_id,
        true,
    )
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not synchronize profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let viewer_recipients = recipients
        .iter()
        .filter(|account_id| *account_id != &session.account_id)
        .cloned()
        .collect::<Vec<_>>();
    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut tx,
        std::slice::from_ref(&session.account_id),
        "account.profile.updated",
        None,
        &serde_json::json!({ "account": account }),
    )
    .await
    .is_err()
        || crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut tx,
            &viewer_recipients,
            "account.directory.changed",
            None,
            &serde_json::json!({
                "accountId": account.account_id,
                "avatarVersion": account.avatar.version,
                "agentAvatarVersion": account.default_agent.avatar.version,
            }),
        )
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not synchronize profile.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let events = state.events().clone();
    let account_for_event = account.clone();
    let observer_account_ids = recipients;
    tokio::spawn(async move {
        for observer_account_id in observer_account_ids {
            events
                .publish_profile_updated(
                    &account_for_event.account_id,
                    &observer_account_id,
                    account_for_event.display_name.as_deref(),
                    account_for_event.avatar_url.as_deref(),
                )
                .await;
        }
    });
    Json(account).into_response()
}

/// Whether `error` is another account already holding the requested handle.
fn is_public_handle_taken(error: &sqlx_core::Error) -> bool {
    error.as_database_error().is_some_and(|database_error| {
        database_error.code().as_deref() == Some("23505")
            && database_error.constraint() == Some("idx_cloud_accounts_public_handle_lower")
    })
}

fn avatar_activation_error(error: crate::avatars::assets::AvatarAssetError) -> Response {
    match error {
        crate::avatars::assets::AvatarAssetError::Invalid(message) => {
            err("invalid_avatar", message, StatusCode::BAD_REQUEST)
        }
        crate::avatars::assets::AvatarAssetError::Database(error) => {
            eprintln!("[avatars] activate profile asset: {error}");
            err(
                "server_error",
                "Could not update profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
        crate::avatars::assets::AvatarAssetError::Unavailable
        | crate::avatars::assets::AvatarAssetError::ObjectStore => err(
            "avatar_storage_unavailable",
            "Avatar storage is unavailable.",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    }
}

pub(super) async fn me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    match owner_account_response_row(pool, &session.account_id).await {
        Ok(Some(account)) => Json(account).into_response(),
        Ok(None) => err(
            "account_missing",
            "Account no longer exists.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not fetch account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(super) async fn logout(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    if revoke_session(pool, &session.token_id).await.is_err() {
        return err(
            "server_error",
            "Could not revoke session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "auth.logout",
        serde_json::json!({}),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_activation_database_errors_stay_internal() {
        let response = avatar_activation_error(crate::avatars::assets::AvatarAssetError::Database(
            sqlx_core::Error::PoolClosed,
        ));

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
