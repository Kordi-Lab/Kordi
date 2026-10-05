use super::*;

pub(in crate::auth::routes) async fn login(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    Json(req): Json<LoginRequest>,
) -> Response {
    let peer_ip = ip_from_extension(connect_info.as_ref());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return limited_response(retry_after);
    }

    let normalized_email = match validate_email(&req.email) {
        Ok(value) => value,
        Err(err_value) => return map_email_format(err_value),
    };

    if let RateLimitDecision::Limited { retry_after } =
        rate_limiter.check_email_lockout(&normalized_email).await
    {
        return limited_response(retry_after);
    }

    let pool = state.db_pool();

    let row: Option<(String, Option<String>)> = match query_as(
        "SELECT account_id, password_hash \
             FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&normalized_email)
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

    let Some((account_id, password_hash)) = row else {
        rate_limiter.record_email_failure(&normalized_email).await;
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    };
    let Some(password_hash) = password_hash else {
        rate_limiter.record_email_failure(&normalized_email).await;
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    };

    let verified = match tokio::task::spawn_blocking({
        let hash = password_hash.clone();
        let plaintext = req.password.clone();
        move || verify_password(&hash, &plaintext)
    })
    .await
    {
        Ok(Ok(value)) => value,
        _ => {
            return err(
                "server_error",
                "Could not verify password.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if !verified {
        rate_limiter.record_email_failure(&normalized_email).await;
        let _ = write_audit(
            pool,
            Some(&account_id),
            None,
            "auth.login.failure",
            serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string())}),
        )
        .await;
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    }
    rate_limiter.clear_email_failures(&normalized_email).await;

    let registration = match req.device.clone() {
        Some(device) => match normalize_device_registration(device) {
            Ok(value) => value,
            Err(error) => {
                return err(error.code(), error.message(), StatusCode::BAD_REQUEST);
            }
        },
        None => legacy_device_registration(SIGNUP_DEFAULT_DEVICE_NAME),
    };
    let now = Utc::now().to_rfc3339();

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let authorized_device =
        match authorize_device(&mut tx, &account_id, &registration, "pending_review").await {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not register device.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
    let device_id = authorized_device.device_id;

    let issued = match issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let _ = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(&account_id)
    .bind(&device_id)
    .bind("auth.login.success")
    .bind(serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string())}).to_string())
    .bind(&now)
    .execute(&mut *tx)
    .await;

    if authorized_device.is_new_authorization
        && append_device_sync_event(
            &mut tx,
            &account_id,
            "device.added",
            &device_id,
            registration.display_name.as_deref(),
            "pending_review",
        )
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not record device authorization.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit login.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if authorized_device.is_new_authorization {
        let events = state.events().clone();
        let published_account_id = account_id.clone();
        let published_device_id = device_id.clone();
        tokio::spawn(async move {
            events
                .publish_device_event(&published_account_id, "added", &published_device_id)
                .await;
        });
    }

    let account = match account_response_row(pool, &account_id).await {
        Ok(Some(account)) => account,
        _ => {
            return err(
                "server_error",
                "Could not load account.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let body = AuthResponse {
        account,
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
            device_id,
        },
    };
    (StatusCode::OK, Json(body)).into_response()
}
