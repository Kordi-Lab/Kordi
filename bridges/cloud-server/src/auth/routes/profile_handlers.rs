use super::*;

pub(super) async fn update_me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpdateProfileRequest>,
) -> Response {
    let display_name = clean_profile_display_name(req.display_name.as_deref());
    let mut avatar_mutation = req.avatar_mutation;
    let agent_display_name = clean_profile_display_name(req.agent_display_name.as_deref());
    let mut agent_avatar_mutation = req.agent_avatar_mutation;
    let now = Utc::now().to_rfc3339();
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
    let default_agent_id = default_agent_id(&session.account_id);
    if let Some(mutation) = agent_avatar_mutation.as_mut() {
        if let Err(error) = crate::avatars::assets::materialize_legacy_avatar_mutation(
            pool,
            state.s3(),
            &session.account_id,
            "agent",
            &default_agent_id,
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
    let current_agent_row: Option<DefaultAgentProfileRow> = match query_as(
        "SELECT owner_account_id, display_name, avatar_url, avatar_source, avatar_style, \
            avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at \
         FROM cloud_default_agent_profiles WHERE owner_account_id = $1 FOR UPDATE",
    )
    .bind(&session.account_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not update agent profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let Some(current_agent_row) = current_agent_row else {
        return err(
            "account_missing",
            "Default agent profile is unavailable.",
            StatusCode::NOT_FOUND,
        );
    };
    let current_agent_avatar =
        default_agent_profile_from_row(&session.account_id, Some(current_agent_row.clone()), &now)
            .avatar;
    let next_agent_avatar = match agent_avatar_mutation.as_ref() {
        Some(mutation) if mutation.expected_version.is_none() => {
            return err(
                "invalid_avatar_version",
                "Refresh the agent profile before changing its avatar.",
                StatusCode::BAD_REQUEST,
            );
        }
        Some(mutation) => {
            if preserve_avatar_render_key(&mut tx, &current_agent_avatar)
                .await
                .is_err()
            {
                return err(
                    "server_error",
                    "Could not preserve agent avatar history.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
            let next = match apply_avatar_mutation(&current_agent_avatar, mutation, &now) {
                Ok(value) => value,
                Err(AvatarMutationError::Conflict) => {
                    return err(
                        "avatar_conflict",
                        "Agent avatar changed on another device. Refresh and try again.",
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
                    "agent",
                    &default_agent_id,
                    next.uploaded_asset.as_deref().unwrap_or_default(),
                )
                .await
                {
                    return avatar_activation_error(error);
                }
            }
            next
        }
        None => current_agent_avatar,
    };
    let next_agent_url = next_agent_avatar.image_url();
    let updated_agent_row: Option<DefaultAgentProfileRow> = match query_as(
        "UPDATE cloud_default_agent_profiles SET display_name = COALESCE($1, display_name), \
            avatar_url = $2, avatar_source = $3, avatar_style = $4, avatar_seed = $5, \
            avatar_renderer_version = $6, avatar_version = $7, avatar_updated_at = $8, updated_at = $8 \
         WHERE owner_account_id = $9 \
         RETURNING owner_account_id, display_name, avatar_url, avatar_source, avatar_style, \
            avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
    )
    .bind(agent_display_name.as_deref())
    .bind(&next_agent_url)
    .bind(&next_agent_avatar.source)
    .bind(&next_agent_avatar.style)
    .bind(&next_agent_avatar.seed)
    .bind(&next_agent_avatar.renderer_version)
    .bind(next_agent_avatar.version)
    .bind(&now)
    .bind(&session.account_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Could not update agent profile.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some(updated_agent_row) = updated_agent_row else {
        return err(
            "account_missing",
            "Default agent profile is unavailable.",
            StatusCode::NOT_FOUND,
        );
    };
    let avatar_url = next_avatar.image_url();
    let row: Option<AccountRecordRow> = match query_as(
        "UPDATE cloud_accounts SET \
            display_name = COALESCE($1, display_name), avatar_url = $2, avatar_source = $3, \
            avatar_style = $4, avatar_seed = $5, avatar_renderer_version = $6, avatar_version = $7, \
            avatar_updated_at = $8, updated_at = $9 \
         WHERE account_id = $10 \
         RETURNING account_id, public_account_number, display_name, primary_email, avatar_url, password_hash, \
            avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at",
    )
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
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Could not update profile.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some(row) = row else {
        return err(
            "account_missing",
            "Account no longer exists.",
            StatusCode::NOT_FOUND,
        );
    };
    let account = account_response_from_rows(row, Some(updated_agent_row));
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
    match account_response_row(pool, &session.account_id).await {
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

pub(super) async fn get_profile(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return err(
            "invalid_account_id",
            "Kordi ID is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }

    let legacy_account_id = target.starts_with("acct_").then_some(target.as_str());
    let public_account_number = normalize_public_kordi_id(&target);
    if legacy_account_id.is_none() && public_account_number.is_none() {
        return err(
            "invalid_account_id",
            "Enter a nine-digit Kordi ID.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();

    let row: Option<(String, i64, Option<String>, Option<String>)> = match query_as(
        "SELECT account_id, public_account_number, display_name, avatar_url \
         FROM cloud_accounts \
         WHERE ($1::BIGINT IS NOT NULL AND public_account_number = $1) \
            OR ($2::TEXT IS NOT NULL AND account_id = $2)",
    )
    .bind(public_account_number)
    .bind(legacy_account_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let Some((account_id, public_account_number, display_name, avatar_url)) = row else {
        return err(
            "account_missing",
            "No account found with that Kordi ID.",
            StatusCode::NOT_FOUND,
        );
    };

    let is_self = account_id == session.account_id;
    let is_contact = if is_self {
        false
    } else {
        let contact_row: Option<(i32,)> =
            query_as("SELECT 1 FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
                .bind(&session.account_id)
                .bind(&account_id)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
        contact_row.is_some()
    };
    let default_agent = match default_agent_profile_row(pool, &account_id).await {
        Ok(row) => default_agent_profile_from_row(&account_id, row, &Utc::now().to_rfc3339()),
        Err(_) => {
            return err(
                "server_error",
                "Could not fetch agent profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    Json(PublicProfileResponse {
        account_id,
        kordi_id: public_account_number.to_string(),
        display_name,
        avatar_url,
        default_agent,
        node_id: None,
        is_contact,
        is_self,
    })
    .into_response()
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
