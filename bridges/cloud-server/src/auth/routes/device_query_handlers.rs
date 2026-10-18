use super::device_operation_support::{confirm_reviewed_devices_now, device_server_error};
use super::*;
use sqlx_core::{from_row::FromRow, row::Row};
use sqlx_postgres::PgRow;

struct DeviceListRow {
    device_id: String,
    device_name: Option<String>,
    device_platform: Option<String>,
    os_version: Option<String>,
    app_version: Option<String>,
    created_at: String,
    last_seen_at: String,
    authorization_state: String,
    protocol_version: i32,
    last_ack_seq: i64,
    last_sync_at: Option<String>,
    session_expires_at: Option<String>,
    approximate_location: Option<String>,
    session_count: i64,
    online: bool,
    legacy: bool,
    same_machine: bool,
    review_started_at: Option<String>,
}

impl<'row> FromRow<'row, PgRow> for DeviceListRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            device_id: row.try_get("device_id")?,
            device_name: row.try_get("device_name")?,
            device_platform: row.try_get("device_platform")?,
            os_version: row.try_get("os_version")?,
            app_version: row.try_get("app_version")?,
            created_at: row.try_get("created_at")?,
            last_seen_at: row.try_get("last_seen_at")?,
            authorization_state: row.try_get("authorization_state")?,
            protocol_version: row.try_get("protocol_version")?,
            last_ack_seq: row.try_get("last_ack_seq")?,
            last_sync_at: row.try_get("last_sync_at")?,
            session_expires_at: row.try_get("session_expires_at")?,
            approximate_location: row.try_get("approximate_location")?,
            session_count: row.try_get("session_count")?,
            online: row.try_get("online")?,
            legacy: row.try_get("legacy")?,
            same_machine: row.try_get("same_machine")?,
            review_started_at: row.try_get("review_started_at")?,
        })
    }
}

/// Devices idle longer than this are left out of the "Active sessions" list.
/// "Log out of all other devices" still revokes them.
const LISTED_DEVICE_IDLE_HOURS: i64 = 48;

/// Lists the caller's account devices for the "Active sessions" screen.
///
/// A non-revoked device row is returned only when it is the caller's current
/// device, is online in presence, or holds at least one live session token and
/// was active within the last [`LISTED_DEVICE_IDLE_HOURS`]. Rows whose tokens
/// have all expired or been revoked can no longer access the account and are
/// omitted.
pub(super) async fn list_devices(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    if let Err(response) = confirm_reviewed_devices_now(&state, &session.account_id).await {
        return *response;
    }
    let now = Utc::now();
    let presence_cutoff =
        crate::presence::stale_presence_cutoff(now, crate::presence::presence_timeout());
    let rows: Vec<DeviceListRow> = match query_as(
        "SELECT device_id, device_name, device_platform, os_version, app_version, \
                created_at, last_seen_at, authorization_state, protocol_version, \
                last_ack_seq, last_sync_at, session_expires_at, approximate_location, \
                session_count, online, legacy, same_machine, review_started_at \
         FROM ( \
           SELECT d.device_id, d.device_name, d.device_platform, d.os_version, d.app_version, \
                  d.created_at, d.last_seen_at, d.authorization_state, d.protocol_version, \
                  d.last_ack_seq, d.last_sync_at, d.approximate_location, \
                  (SELECT MAX(t.expires_at) FROM cloud_refresh_tokens t \
                   WHERE t.device_id = d.device_id AND t.revoked_at IS NULL \
                     AND t.expires_at > $3) AS session_expires_at, \
                  (SELECT COUNT(*)::BIGINT FROM cloud_refresh_tokens t \
                   WHERE t.device_id = d.device_id AND t.revoked_at IS NULL \
                     AND t.expires_at > $3) AS session_count, \
                  EXISTS (SELECT 1 FROM cloud_device_presence p \
                          WHERE p.device_id = d.device_id AND p.account_id = d.account_id \
                            AND p.state = 'online' AND p.last_heartbeat_at >= $4) AS online, \
                  (d.device_key_algorithm = 'legacy') AS legacy, \
                  (d.device_id <> $2 AND d.machine_hash IS NOT NULL AND d.machine_hash = ( \
                     SELECT m.machine_hash FROM cloud_devices m \
                     WHERE m.account_id = $1 AND m.device_id = $2)) AS same_machine, \
                  CASE WHEN d.authorization_state = 'pending_review' \
                       THEN COALESCE(d.review_started_at, d.created_at) END AS review_started_at \
           FROM cloud_devices d \
           WHERE d.account_id = $1 AND d.revoked_at IS NULL \
         ) devices \
         WHERE device_id = $2 OR online \
            OR (session_count > 0 AND last_seen_at >= $5) \
         ORDER BY (device_id = $2) DESC, last_seen_at DESC, created_at DESC",
    )
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(now.to_rfc3339())
    .bind(presence_cutoff.to_rfc3339())
    .bind((now - chrono::Duration::hours(LISTED_DEVICE_IDLE_HOURS)).to_rfc3339())
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => return device_server_error("Could not load authorized devices."),
    };

    Json(DeviceListResponse {
        devices: rows
            .into_iter()
            .map(|row| {
                let (display_name, sign_in_method) =
                    crate::auth::devices::device_display_identity(row.device_name);
                DeviceAuthorizationResponse {
                    current_device: row.device_id == session.device_id,
                    device_id: row.device_id,
                    display_name,
                    platform: row.device_platform,
                    os_version: row.os_version,
                    app_version: row.app_version,
                    created_at: row.created_at,
                    last_active_at: row.last_seen_at,
                    authorization_state: row.authorization_state,
                    session_expires_at: row.session_expires_at,
                    approximate_location: row.approximate_location,
                    sync_status: DeviceSyncStatusResponse {
                        protocol_version: row.protocol_version,
                        last_applied_sequence: row.last_ack_seq,
                        last_successful_catch_up_at: row.last_sync_at,
                    },
                    online: row.online,
                    session_count: row.session_count,
                    legacy: row.legacy,
                    sign_in_method,
                    same_machine: row.same_machine,
                    review_ends_at: row
                        .review_started_at
                        .as_deref()
                        .and_then(crate::auth::devices::device_review_ends_at),
                }
            })
            .collect(),
    })
    .into_response()
}

pub(super) async fn update_current_device_metadata(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<DeviceMetadataUpdateRequest>,
) -> Response {
    let machine_hash = request
        .machine_id
        .as_deref()
        .and_then(|machine_id| crate::auth::devices::machine_hash(&session.account_id, machine_id));
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
           approximate_location = COALESCE($5, approximate_location), \
           machine_hash = COALESCE($8, machine_hash) \
         WHERE account_id = $6 AND device_id = $7 AND revoked_at IS NULL",
    )
    .bind(metadata.display_name.as_deref())
    .bind(metadata.platform.as_deref())
    .bind(metadata.os_version.as_deref())
    .bind(metadata.app_version.as_deref())
    .bind(metadata.approximate_location.as_deref())
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(machine_hash.as_deref())
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
