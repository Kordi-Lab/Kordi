use super::*;

pub(super) async fn update_me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpdateProfileRequest>,
) -> Response {
    let display_name = clean_profile_display_name(req.display_name.as_deref());
    let avatar_url = match clean_optional_uploaded_avatar_url(req.avatar_url.as_deref()) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_accounts \
         SET display_name = COALESCE($1, display_name), \
             avatar_url = COALESCE($2, avatar_url), \
             updated_at = $3 \
         WHERE account_id = $4",
    )
    .bind(display_name.as_deref())
    .bind(avatar_url.as_deref())
    .bind(&now)
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not update profile.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    match account_response_row(state.db_pool(), &session.account_id).await {
        Ok(Some(account)) => {
            let observers: Vec<(String,)> =
                query_as("SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1")
                    .bind(&session.account_id)
                    .fetch_all(state.db_pool())
                    .await
                    .unwrap_or_default();
            let mut observer_account_ids: HashSet<String> = observers
                .into_iter()
                .map(|(observer_account_id,)| observer_account_id)
                .collect();
            observer_account_ids.insert(session.account_id.clone());
            if !observer_account_ids.is_empty() {
                let events = state.events().clone();
                let account_id = account.account_id.clone();
                let display_name = account.display_name.clone();
                let avatar_url = account.avatar_url.clone();
                tokio::spawn(async move {
                    for observer_account_id in observer_account_ids {
                        events
                            .publish_profile_updated(
                                &account_id,
                                &observer_account_id,
                                display_name.as_deref(),
                                avatar_url.as_deref(),
                            )
                            .await;
                    }
                });
            }
            Json(account).into_response()
        }
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

pub(super) fn decoded_base64_len(encoded: &str) -> usize {
    let trimmed = encoded.trim_end_matches('=');
    (trimmed.len() * 3) / 4
}

pub(super) fn clean_optional_uploaded_avatar_url(
    value: Option<&str>,
) -> Result<Option<String>, Box<Response>> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.starts_with(AVATAR_SEED_PREFIX) {
        return Err(boxed_err(
            "invalid_avatar",
            "Avatar must be an uploaded image.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if let Some(payload) = raw
        .strip_prefix("data:image/png;base64,")
        .or_else(|| raw.strip_prefix("data:image/jpeg;base64,"))
        .or_else(|| raw.strip_prefix("data:image/webp;base64,"))
    {
        if decoded_base64_len(payload) <= AVATAR_UPLOAD_MAX_BYTES {
            return Ok(Some(raw.to_string()));
        }
        return Err(boxed_err(
            "invalid_avatar",
            "Avatar payload is too large after processing.",
            StatusCode::BAD_REQUEST,
        ));
    }
    Err(boxed_err(
        "invalid_avatar",
        "Avatar must be a PNG, JPEG, or WebP image.",
        StatusCode::BAD_REQUEST,
    ))
}

pub(super) fn clean_required_signup_avatar_url(
    value: Option<&str>,
) -> Result<String, Box<Response>> {
    match clean_optional_uploaded_avatar_url(value) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(boxed_err(
            "missing_avatar",
            "Upload an avatar to sign up.",
            StatusCode::BAD_REQUEST,
        )),
        Err(response) => Err(response),
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

    Json(PublicProfileResponse {
        account_id,
        kordi_id: public_account_number.to_string(),
        display_name,
        avatar_url,
        node_id: None,
        is_contact,
        is_self,
    })
    .into_response()
}
