use super::device_operation_support::device_server_error;
use super::*;

type DeviceListRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    i32,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(super) async fn list_devices(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let now = Utc::now();
    let presence_cutoff =
        crate::presence::stale_presence_cutoff(now, crate::presence::presence_timeout())
            .to_rfc3339();
    let rows: Vec<DeviceListRow> = match query_as(
        "SELECT d.device_id, d.device_name, d.device_platform, d.os_version, d.app_version, \
                d.created_at, d.last_seen_at, d.authorization_state, d.protocol_version, \
                d.last_ack_seq, d.last_sync_at, \
                (SELECT MAX(t.expires_at) FROM cloud_refresh_tokens t \
                 WHERE t.device_id = d.device_id AND t.revoked_at IS NULL AND t.expires_at > $3), \
                d.approximate_location \
         FROM cloud_devices d \
         WHERE d.account_id = $1 AND d.revoked_at IS NULL \
           AND (d.device_id = $2 \
             OR EXISTS (SELECT 1 FROM cloud_refresh_tokens t \
                        WHERE t.device_id = d.device_id AND t.revoked_at IS NULL \
                          AND t.expires_at > $3) \
             OR EXISTS (SELECT 1 FROM cloud_device_presence p \
                        WHERE p.device_id = d.device_id AND p.account_id = d.account_id \
                          AND p.state = 'online' AND p.last_heartbeat_at >= $4)) \
         ORDER BY (d.device_id = $2) DESC, d.last_seen_at DESC, d.created_at DESC",
    )
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(now.to_rfc3339())
    .bind(presence_cutoff)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => return device_server_error("Could not load authorized devices."),
    };

    Json(DeviceListResponse {
        devices: rows
            .into_iter()
            .map(
                |(
                    device_id,
                    display_name,
                    platform,
                    os_version,
                    app_version,
                    created_at,
                    last_active_at,
                    authorization_state,
                    protocol_version,
                    last_applied_sequence,
                    last_successful_catch_up_at,
                    session_expires_at,
                    approximate_location,
                )| DeviceAuthorizationResponse {
                    current_device: device_id == session.device_id,
                    device_id,
                    display_name,
                    platform,
                    os_version,
                    app_version,
                    created_at,
                    last_active_at,
                    authorization_state,
                    session_expires_at,
                    approximate_location,
                    sync_status: DeviceSyncStatusResponse {
                        protocol_version,
                        last_applied_sequence,
                        last_successful_catch_up_at,
                    },
                },
            )
            .collect(),
    })
    .into_response()
}

pub(super) async fn update_current_device_metadata(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<DeviceMetadataUpdateRequest>,
) -> Response {
    let metadata = normalize_device_metadata(request);
    let updated = query(
        "UPDATE cloud_devices SET \
           device_name = CASE \
             WHEN $1 IS NULL THEN device_name \
             WHEN device_name IS NULL OR device_name LIKE 'oauth-%-device' \
               OR device_name = 'cloud-email-password-device' THEN $1 \
             ELSE device_name \
           END, \
           device_platform = COALESCE($2, device_platform), \
           os_version = COALESCE($3, os_version), \
           app_version = COALESCE($4, app_version), \
           approximate_location = COALESCE($5, approximate_location) \
         WHERE account_id = $6 AND device_id = $7 AND revoked_at IS NULL",
    )
    .bind(metadata.display_name.as_deref())
    .bind(metadata.platform.as_deref())
    .bind(metadata.os_version.as_deref())
    .bind(metadata.app_version.as_deref())
    .bind(metadata.approximate_location.as_deref())
    .bind(&session.account_id)
    .bind(&session.device_id)
    .execute(state.db_pool())
    .await;

    match updated {
        Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(
            "device_not_found",
            "The current device authorization is unavailable.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => device_server_error("Could not update current device details."),
    }
}
