//! Organization settings. Today there is one: whether members may sign in
//! with a device code (`deviceCodeSignIn`).
//!
//! A stored NULL follows the default: allowed for personal organizations and
//! for team organizations people created themselves, off for organizations
//! created from deployment configuration until an owner or admin turns it
//! on. An account that belongs to any organization where it is off cannot
//! sign in with a device code, because the sign-in covers the whole account.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::handlers::lock_for_change;
use super::policy::OrganizationRole;
use super::{err, server_error, ApiError};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// SQL for whether an organization row `o` allows device code sign-in.
const DEVICE_CODE_ALLOWED: &str = "COALESCE(o.device_code_sign_in, o.config_id IS NULL)";

/// The name of an organization of `account_id` that does not allow device
/// code sign-in, or `None` when every one of its organizations allows it.
pub async fn device_code_sign_in_blocked_by(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(&format!(
        "SELECT o.name FROM cloud_organization_members m \
         JOIN cloud_organizations o ON o.organization_id = m.organization_id \
         WHERE m.account_id = $1 AND NOT {DEVICE_CODE_ALLOWED} \
         ORDER BY o.created_at, o.organization_id LIMIT 1"
    ))
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(name,)| name))
}

fn settings_body(stored: Option<bool>, configured: bool) -> Value {
    let default = !configured;
    json!({
        "settings": {
            "deviceCodeSignIn": stored.unwrap_or(default),
            "deviceCodeSignInDefault": default,
        }
    })
}

/// `GET /v1/cloud/organizations/:organization_id/settings`: any member.
pub(super) async fn get_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
) -> Response {
    let row: Result<Option<(Option<bool>, bool)>, _> = query_as(
        "SELECT o.device_code_sign_in, o.config_id IS NOT NULL \
         FROM cloud_organizations o \
         JOIN cloud_organization_members m ON m.organization_id = o.organization_id \
         WHERE o.organization_id = $1 AND m.account_id = $2",
    )
    .bind(&organization_id)
    .bind(&session.account_id)
    .fetch_optional(state.db_pool())
    .await;
    match row {
        Ok(Some((stored, configured))) => Json(settings_body(stored, configured)).into_response(),
        Ok(None) => super::not_found().into_response(),
        Err(_) => server_error().into_response(),
    }
}

/// `PATCH /v1/cloud/organizations/:organization_id/settings`: owners and
/// admins. `{"deviceCodeSignIn": true | false | null}`; null restores the
/// default.
pub(super) async fn update_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Json(request): Json<Value>,
) -> Response {
    let setting = match request.get("deviceCodeSignIn") {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::Null) => None,
        _ => {
            return err(
                "invalid_settings",
                "deviceCodeSignIn must be true, false, or null.",
                StatusCode::BAD_REQUEST,
            )
            .into_response()
        }
    };
    let result: Result<Value, ApiError> = async {
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (_, role) = lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        if role == OrganizationRole::Member {
            return Err(err(
                "organization_forbidden",
                "Only owners and admins can change settings.",
                StatusCode::FORBIDDEN,
            ));
        }
        let (configured,): (bool,) = query_as(
            "UPDATE cloud_organizations SET device_code_sign_in = $1 \
             WHERE organization_id = $2 RETURNING config_id IS NOT NULL",
        )
        .bind(setting)
        .bind(&organization_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        query(
            "INSERT INTO cloud_audit_events \
             (event_id, account_id, device_id, event_type, metadata_json, created_at) \
             VALUES ($1, $2, $3, 'organization.settings.updated', $4, $5)",
        )
        .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
        .bind(&session.account_id)
        .bind(&session.device_id)
        .bind(json!({ "organizationId": organization_id, "deviceCodeSignIn": setting }).to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        tx.commit().await.map_err(|_| server_error())?;
        Ok(settings_body(setting, configured))
    }
    .await;
    match result {
        Ok(body) => Json(body).into_response(),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_organizations_default_to_off() {
        assert_eq!(
            settings_body(None, true)["settings"]["deviceCodeSignIn"],
            false
        );
        assert_eq!(
            settings_body(None, false)["settings"]["deviceCodeSignIn"],
            true
        );
        assert_eq!(
            settings_body(Some(true), true)["settings"]["deviceCodeSignIn"],
            true
        );
        assert_eq!(
            settings_body(Some(false), false)["settings"]["deviceCodeSignIn"],
            false
        );
    }
}
