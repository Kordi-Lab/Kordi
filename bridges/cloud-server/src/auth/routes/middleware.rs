use super::*;

pub async fn cloud_session_middleware(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    mut req: Request,
    next: Next,
) -> Response {
    let token = match bearer_token_from_headers(&headers) {
        Some(token) if token.starts_with(SESSION_TOKEN_PREFIX) => token.to_string(),
        _ => {
            return err(
                "invalid_session",
                "Missing or malformed session token.",
                StatusCode::UNAUTHORIZED,
            );
        }
    };

    let pool = state.db_pool();
    match lookup_session(pool, &token).await {
        Ok(Some(row)) => {
            let _ = bump_expiry(pool, &row.token_id, DEFAULT_SESSION_LIFETIME_DAYS).await;
            let _ = touch_device_activity(pool, &row.account_id, &row.device_id).await;
            req.extensions_mut().insert(CloudSession {
                token_id: row.token_id,
                account_id: row.account_id,
                device_id: row.device_id,
            });
            next.run(req).await
        }
        Ok(None) => err(
            "invalid_session",
            "Session is expired or revoked.",
            StatusCode::UNAUTHORIZED,
        ),
        Err(_) => err(
            "server_error",
            "Could not validate session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
