//! `POST /v1/cloud/memory/import/extract`: reads one file the person chose in
//! the browser app into memories with the hosted model (`crate::memory_import`).
//! Nothing is saved here; the client saves the memories it keeps.

use super::*;
use crate::auth::rate_limit::MEMORY_IMPORT_EXTRACT_LIMIT;
use crate::memory_import::{self, ExtractError, ExtractRequest, ExtractResponse};
use crate::organizations::requests::RequestOrganization;

pub(super) async fn extract_memory_import(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    organization: Option<Extension<RequestOrganization>>,
    input: Result<Json<ExtractRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return err(
            "invalid_memory_import",
            "Choose a text file of 200 KB or less.",
            StatusCode::BAD_REQUEST,
        );
    };
    // Malformed and oversized requests are refused before they spend the budget.
    if let Err(error) = input.validate() {
        return error_response(error);
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(MEMORY_IMPORT_EXTRACT_LIMIT, &session.account_id)
        .await
    {
        return limited_response(retry_after);
    }
    let Some(service) = state.system_agent() else {
        return error_response(ExtractError::Unavailable);
    };
    let pools = service.config().resource_pools();
    let organization_id = organization
        .as_ref()
        .map(|Extension(organization)| organization.organization_id.as_str());
    match memory_import::extract(
        state.db_pool(),
        &pools,
        &session.account_id,
        organization_id,
        &input,
    )
    .await
    {
        Ok(memories) => Json(ExtractResponse { memories }).into_response(),
        Err(error) => error_response(error),
    }
}

fn error_response(error: ExtractError) -> Response {
    match error {
        ExtractError::InvalidFileName => err(
            "invalid_memory_import",
            "Choose a file with a name.",
            StatusCode::BAD_REQUEST,
        ),
        ExtractError::EmptyText => err(
            "memory_import_empty",
            "This file is empty.",
            StatusCode::BAD_REQUEST,
        ),
        ExtractError::TextTooLarge => err(
            "memory_import_too_large",
            "Files must be 200 KB or smaller.",
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        ExtractError::TooManyExistingMemories => err(
            "invalid_memory_import",
            "Too many existing memories were sent.",
            StatusCode::BAD_REQUEST,
        ),
        ExtractError::ConsentRequired => crate::ai_consent::required_response(),
        ExtractError::Unavailable => err(
            "memory_import_unavailable",
            "Import is not available right now. Try again later.",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        ExtractError::UsageLimit => err(
            "memory_import_limit",
            "You have reached today's import limit. Try again tomorrow.",
            StatusCode::TOO_MANY_REQUESTS,
        ),
        ExtractError::Model => err(
            "memory_import_failed",
            "Could not read this file. Try again.",
            StatusCode::BAD_GATEWAY,
        ),
        ExtractError::Database => err(
            "server_error",
            "Something went wrong. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
