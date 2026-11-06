//! Whether an account shares its content with AI models
//! (docs/development/ai-consent.md).
//!
//! An account is `unset` until its owner decides, then `allowed` or
//! `declined`. Only `declined` is enforced: AI entry points refuse it with
//! `403 ai_consent_required`, and background AI work skips it. `unset`
//! behaves as before so older clients keep working; newer clients ask
//! before the first AI action.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

mod routes;
#[cfg(test)]
mod tests;

pub(crate) use routes::routes;

/// The error code AI routes answer a declined account with.
pub const AI_CONSENT_REQUIRED: &str = "ai_consent_required";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiConsentStatus {
    Unset,
    Allowed,
    Declined,
}

impl AiConsentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unset => "unset",
            Self::Allowed => "allowed",
            Self::Declined => "declined",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "allowed" => Self::Allowed,
            "declined" => Self::Declined,
            _ => Self::Unset,
        }
    }
}

/// The account's decision, as the API reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConsent {
    pub status: AiConsentStatus,
    pub decided_at: Option<DateTime<Utc>>,
}

/// The decision of `account_id`; `unset` for an unknown account.
pub async fn load<'e, E>(executor: E, account_id: &str) -> sqlx_core::Result<AiConsent>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let row: Option<(String, Option<DateTime<Utc>>)> = query_as(
        "SELECT ai_consent_status, ai_consent_decided_at FROM cloud_accounts \
         WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(executor)
    .await?;
    Ok(match row {
        Some((status, decided_at)) => AiConsent {
            status: AiConsentStatus::parse(&status),
            decided_at,
        },
        None => AiConsent {
            status: AiConsentStatus::Unset,
            decided_at: None,
        },
    })
}

/// Whether `account_id` declined AI models.
pub async fn is_declined<'e, E>(executor: E, account_id: &str) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    Ok(load(executor, account_id).await?.status == AiConsentStatus::Declined)
}

/// The people among `account_ids` who have not allowed AI models: declined
/// or still undecided. Background AI leaves them out. Server-managed
/// accounts are not people and are never listed.
pub async fn not_allowed_among<'e, E>(
    executor: E,
    account_ids: &[String],
) -> sqlx_core::Result<std::collections::HashSet<String>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let people: Vec<String> = account_ids
        .iter()
        .filter(|id| !crate::system_account::is_service_account(id))
        .cloned()
        .collect();
    let rows: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_accounts \
         WHERE account_id = ANY($1) AND ai_consent_status <> 'allowed'",
    )
    .bind(&people)
    .fetch_all(executor)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether `account_id` allowed AI models, which background AI needs.
/// Server-managed accounts always count as allowed.
pub async fn is_allowed<'e, E>(executor: E, account_id: &str) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    if crate::system_account::is_service_account(account_id) {
        return Ok(true);
    }
    Ok(load(executor, account_id).await?.status == AiConsentStatus::Allowed)
}

/// Whether any of `account_ids` declined AI models.
pub async fn any_declined(pool: &PgPool, account_ids: &[&str]) -> sqlx_core::Result<bool> {
    let ids: Vec<String> = account_ids.iter().map(|id| id.to_string()).collect();
    let (declined,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_accounts \
         WHERE account_id = ANY($1) AND ai_consent_status = 'declined')",
    )
    .bind(&ids)
    .fetch_one(pool)
    .await?;
    Ok(declined)
}

/// The refusal AI routes send a declined account, in the shared error
/// envelope.
pub fn required_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "errorCode": AI_CONSENT_REQUIRED,
            "message": "AI models are off. Allow them in Settings › Privacy to use agents.",
        })),
    )
        .into_response()
}

/// The error code when someone asks another person's agent and that person
/// has not allowed AI models.
pub const AGENT_OWNER_AI_CONSENT_REQUIRED: &str = "agent_owner_ai_consent_required";

/// The refusal for a run of another person's agent whose owner has not
/// allowed AI models.
pub fn owner_required_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "errorCode": AGENT_OWNER_AI_CONSENT_REQUIRED,
            "message": "This agent's owner hasn't turned on AI models.",
        })),
    )
        .into_response()
}

/// Refuses a run that `requester` asks of `owner`'s agent: the requester
/// must not have declined AI, and when they ask someone else's agent, its
/// owner did not start the work, so the owner must have allowed AI. A
/// person's own request while undecided runs, since their client asks first.
pub async fn require_for_run(
    pool: &PgPool,
    requester: &str,
    owner: &str,
) -> Result<(), Box<Response>> {
    require(pool, &[requester]).await?;
    if owner == requester {
        return require(pool, &[owner]).await;
    }
    match is_allowed(pool, owner).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(Box::new(owner_required_response())),
        Err(error) => {
            eprintln!("[ai-consent] Could not read AI consent: {error}");
            Err(Box::new(unavailable()))
        }
    }
}

fn unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "errorCode": "server_error",
            "message": "Something went wrong. Try again.",
        })),
    )
        .into_response()
}

/// Refuses AI work on behalf of `account_ids` when any of them declined. A
/// database error refuses too, so the gate never fails open.
pub async fn require(pool: &PgPool, account_ids: &[&str]) -> Result<(), Box<Response>> {
    match any_declined(pool, account_ids).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(Box::new(required_response())),
        Err(error) => {
            eprintln!("[ai-consent] Could not read AI consent: {error}");
            Err(Box::new(unavailable()))
        }
    }
}
