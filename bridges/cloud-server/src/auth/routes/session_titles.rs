use super::*;

pub(super) fn normalized_source_session_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return None;
    }
    Some(trimmed.to_string())
}

pub(super) async fn caller_can_access_cloud_session(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<bool, sqlx_core::error::Error> {
    let participants = cloud_session_participants(pool, session_id).await?;
    Ok(participants
        .iter()
        .any(|participant| participant == account_id))
}

pub(super) fn normalized_cloud_session_title_source(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "placeholder" | "auto" | "imported" | "external" | "legacy" | "manual"
    )
    .then_some(normalized)
}

pub(super) fn cloud_session_title_source_precedence(value: &str) -> u8 {
    match value {
        "manual" => 4,
        "imported" | "external" => 3,
        "legacy" => 2,
        "auto" => 1,
        _ => 0,
    }
}

pub(super) fn incoming_cloud_session_title_wins(
    existing: &CloudSessionTitleSummary,
    incoming: &CloudSessionTitleSummary,
) -> bool {
    match cloud_session_title_source_precedence(&incoming.title_source).cmp(
        &cloud_session_title_source_precedence(&existing.title_source),
    ) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => match incoming.title_source.as_str() {
            "auto" => {
                incoming.title_revision > existing.title_revision && incoming.title_revision <= 2
            }
            "manual" | "imported" | "external" | "legacy" => {
                incoming.updated_at_ms > existing.updated_at_ms
                    || (incoming.updated_at_ms == existing.updated_at_ms
                        && (incoming.title_revision > existing.title_revision
                            || (incoming.title_revision == existing.title_revision
                                && incoming.updated_by_account_id
                                    < existing.updated_by_account_id)))
            }
            _ => existing.title.trim().is_empty(),
        },
    }
}

pub(super) async fn select_cloud_session_title(
    pool: &PgPool,
    session_id: &str,
) -> Result<Option<CloudSessionTitleSummary>, sqlx_core::error::Error> {
    query_as::<
        _,
        (
            String,
            String,
            i64,
            i64,
            Option<String>,
            i64,
            String,
            String,
        ),
    >(
        "SELECT title, title_source, title_revision, title_policy_version, \
                title_generated_from_message_id, client_updated_at_ms, \
                updated_by_account_id, updated_at \
         FROM cloud_session_titles WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map(|row| {
        row.map(
            |(
                title,
                title_source,
                title_revision,
                title_policy_version,
                title_generated_from_message_id,
                updated_at_ms,
                updated_by_account_id,
                updated_at,
            )| CloudSessionTitleSummary {
                session_id: session_id.to_string(),
                title,
                title_source,
                title_revision,
                title_policy_version,
                title_generated_from_message_id,
                updated_at_ms,
                updated_by_account_id,
                updated_at,
            },
        )
    })
}

pub(super) async fn get_cloud_session_title(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let pool = state.db_pool();
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
            return err(
                "not_a_participant",
                "You can only inspect titles for sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    match select_cloud_session_title(pool, &session_id).await {
        Ok(Some(session_title)) => {
            Json(CloudSessionTitleResponse { session_title }).into_response()
        }
        Ok(None) => err(
            "title_not_found",
            "This session does not have a synchronized title yet.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not load the session title.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(super) async fn update_cloud_session_title(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
    Json(req): Json<UpdateCloudSessionTitleRequest>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let title = req.title.trim();
    if title.is_empty() || title.chars().count() > 256 {
        return err(
            "invalid_title",
            "title must contain between 1 and 256 characters.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(title_source) = normalized_cloud_session_title_source(&req.title_source) else {
        return err(
            "invalid_title_source",
            "titleSource is not supported.",
            StatusCode::BAD_REQUEST,
        );
    };
    if req.title_revision < 0
        || req.title_policy_version < 1
        || req.updated_at_ms < 0
        || (title_source == "auto" && req.title_revision > 2)
    {
        return err(
            "invalid_title_revision",
            "Title revision metadata is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    let generated_from_message_id = req
        .title_generated_from_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if generated_from_message_id
        .as_ref()
        .is_some_and(|value| value.chars().count() > 512)
    {
        return err(
            "invalid_message_id",
            "titleGeneratedFromMessageId is too long.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();
    let participants = match cloud_session_participants(pool, &session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only update titles for sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let updated_at = Utc::now().to_rfc3339();
    let incoming = CloudSessionTitleSummary {
        session_id: session_id.clone(),
        title: title.to_string(),
        title_source,
        title_revision: req.title_revision,
        title_policy_version: req.title_policy_version,
        title_generated_from_message_id: generated_from_message_id,
        updated_at_ms: req.updated_at_ms,
        updated_by_account_id: session.account_id.clone(),
        updated_at,
    };
    let existing = match select_cloud_session_title(pool, &session_id).await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not load the session title.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if let Some(existing) = existing.as_ref() {
        let identical = existing.title == incoming.title
            && existing.title_source == incoming.title_source
            && existing.title_revision == incoming.title_revision
            && existing.title_policy_version == incoming.title_policy_version
            && existing.title_generated_from_message_id == incoming.title_generated_from_message_id;
        if identical || !incoming_cloud_session_title_wins(existing, &incoming) {
            return Json(CloudSessionTitleResponse {
                session_title: existing.clone(),
            })
            .into_response();
        }
    }

    let upsert_result = query(
        "INSERT INTO cloud_session_titles( \
             session_id, title, title_source, title_revision, title_policy_version, \
             title_generated_from_message_id, client_updated_at_ms, updated_by_account_id, updated_at \
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT(session_id) DO UPDATE SET \
             title = EXCLUDED.title, title_source = EXCLUDED.title_source, \
             title_revision = EXCLUDED.title_revision, \
             title_policy_version = EXCLUDED.title_policy_version, \
             title_generated_from_message_id = EXCLUDED.title_generated_from_message_id, \
             client_updated_at_ms = EXCLUDED.client_updated_at_ms, \
             updated_by_account_id = EXCLUDED.updated_by_account_id, \
             updated_at = EXCLUDED.updated_at \
         WHERE \
             (CASE EXCLUDED.title_source \
                 WHEN 'manual' THEN 4 WHEN 'imported' THEN 3 WHEN 'external' THEN 3 \
                 WHEN 'legacy' THEN 2 WHEN 'auto' THEN 1 ELSE 0 END) \
             > \
             (CASE cloud_session_titles.title_source \
                 WHEN 'manual' THEN 4 WHEN 'imported' THEN 3 WHEN 'external' THEN 3 \
                 WHEN 'legacy' THEN 2 WHEN 'auto' THEN 1 ELSE 0 END) \
             OR ( \
                 (CASE EXCLUDED.title_source \
                     WHEN 'manual' THEN 4 WHEN 'imported' THEN 3 WHEN 'external' THEN 3 \
                     WHEN 'legacy' THEN 2 WHEN 'auto' THEN 1 ELSE 0 END) \
                 = \
                 (CASE cloud_session_titles.title_source \
                     WHEN 'manual' THEN 4 WHEN 'imported' THEN 3 WHEN 'external' THEN 3 \
                     WHEN 'legacy' THEN 2 WHEN 'auto' THEN 1 ELSE 0 END) \
                 AND ( \
                     (EXCLUDED.title_source = 'auto' \
                         AND EXCLUDED.title_revision > cloud_session_titles.title_revision \
                         AND EXCLUDED.title_revision <= 2) \
                     OR (EXCLUDED.title_source IN ('manual', 'imported', 'external', 'legacy') \
                         AND ( \
                             EXCLUDED.client_updated_at_ms > cloud_session_titles.client_updated_at_ms \
                             OR (EXCLUDED.client_updated_at_ms = cloud_session_titles.client_updated_at_ms \
                                 AND ( \
                                     EXCLUDED.title_revision > cloud_session_titles.title_revision \
                                     OR (EXCLUDED.title_revision = cloud_session_titles.title_revision \
                                         AND EXCLUDED.updated_by_account_id < cloud_session_titles.updated_by_account_id) \
                                 )) \
                         )) \
                     OR (EXCLUDED.title_source = 'placeholder' \
                         AND BTRIM(cloud_session_titles.title) = '') \
                 ) \
             )",
    )
    .bind(&incoming.session_id)
    .bind(&incoming.title)
    .bind(&incoming.title_source)
    .bind(incoming.title_revision)
    .bind(incoming.title_policy_version)
    .bind(&incoming.title_generated_from_message_id)
    .bind(incoming.updated_at_ms)
    .bind(&incoming.updated_by_account_id)
    .bind(&incoming.updated_at)
    .execute(pool)
    .await;
    let upsert_result = match upsert_result {
        Ok(result) => result,
        Err(_) => {
            return err(
                "server_error",
                "Could not update the session title.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if upsert_result.rows_affected() == 0 {
        return match select_cloud_session_title(pool, &session_id).await {
            Ok(Some(session_title)) => {
                Json(CloudSessionTitleResponse { session_title }).into_response()
            }
            _ => err(
                "server_error",
                "Could not resolve the synchronized session title.",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        };
    }

    let payload = serde_json::json!({ "sessionTitle": &incoming });
    for account_id in participants {
        let _ = append_cloud_sync_event(
            pool,
            &account_id,
            "session.title.updated",
            Some(&session_id),
            incoming.title_generated_from_message_id.as_deref(),
            payload.clone(),
            &incoming.updated_at,
        )
        .await;
    }
    Json(CloudSessionTitleResponse {
        session_title: incoming,
    })
    .into_response()
}

#[cfg(test)]
mod tests;
