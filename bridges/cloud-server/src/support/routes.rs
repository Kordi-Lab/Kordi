use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query_as::query_as;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::server::ServerState;

use super::tickets::{
    create_ticket, ticket_by_submission_id, NewSupportTicket, StoredSupportTicket,
};

const SUBJECT_MAX_CHARS: usize = 160;
const DESCRIPTION_MAX_CHARS: usize = 12_000;
const SESSION_ID_MAX_CHARS: usize = 512;
const SUBMISSION_ID_MAX_CHARS: usize = 128;
const MAX_TICKETS_PER_HOUR: i64 = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSupportTicketRequest {
    category: String,
    subject: String,
    description: String,
    session_id: Option<String>,
    diagnostics: Option<SupportDiagnostics>,
    consent: SupportSubmissionConsent,
    client_submission_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportSubmissionConsent {
    report_submission: bool,
    diagnostics: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportDiagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    os_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportTicketResponse {
    ticket_id: String,
    status: String,
    created_at: String,
    created: bool,
    notification_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportTicketLookupResponse {
    ticket: Option<SupportTicketResponse>,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/support/tickets", post(create_support_ticket))
        .route(
            "/v1/cloud/support/tickets/by-submission/:client_submission_id",
            get(get_support_ticket_by_submission),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

fn ticket_response(ticket: StoredSupportTicket) -> SupportTicketResponse {
    SupportTicketResponse {
        ticket_id: ticket.ticket_id,
        status: "received".to_string(),
        created_at: ticket.created_at,
        created: ticket.created,
        notification_status: ticket.notification_status,
    }
}

fn should_schedule_immediate_delivery(ticket: &StoredSupportTicket) -> bool {
    ticket.created
}

async fn get_support_ticket_by_submission(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(client_submission_id): Path<String>,
) -> Response {
    let client_submission_id = match clean_required(
        &client_submission_id,
        "clientSubmissionId",
        SUBMISSION_ID_MAX_CHARS,
    ) {
        Ok(value) => value,
        Err(message) => {
            return error("invalid_support_ticket", &message, StatusCode::BAD_REQUEST);
        }
    };
    match ticket_by_submission_id(state.db_pool(), &session.account_id, &client_submission_id).await
    {
        Ok(ticket) => (
            StatusCode::OK,
            Json(SupportTicketLookupResponse {
                ticket: ticket.map(ticket_response),
            }),
        )
            .into_response(),
        Err(error_value) => {
            eprintln!("[support] restore ticket status: {error_value}");
            error(
                "server_error",
                "Could not restore the support request status.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}

fn clean_required(value: &str, field: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required."));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("{field} is too long."));
    }
    Ok(trimmed.to_string())
}

fn clean_optional(value: Option<&str>, max_chars: usize) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err("sessionId is too long.".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn clean_subject(value: &str) -> Result<String, String> {
    let subject = clean_required(value, "subject", SUBJECT_MAX_CHARS)?;
    if subject.chars().any(char::is_control) {
        return Err("subject contains unsupported characters.".to_string());
    }
    Ok(subject)
}

async fn account_ticket_limit_reached(
    state: &ServerState,
    account_id: &str,
    client_submission_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let since = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_support_tickets
         WHERE account_id = $1 AND created_at >= $2 AND client_submission_id <> $3",
    )
    .bind(account_id)
    .bind(since)
    .bind(client_submission_id)
    .fetch_one(state.db_pool())
    .await?;
    Ok(count >= MAX_TICKETS_PER_HOUR)
}

fn clean_diagnostic(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().chars().take(160).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn support_ticket_metadata(
    consent: &SupportSubmissionConsent,
    diagnostics: Option<SupportDiagnostics>,
) -> Result<serde_json::Value, String> {
    if !consent.report_submission {
        return Err("Confirm permission before sending this report.".to_string());
    }
    if diagnostics.is_some() && !consent.diagnostics {
        return Err(
            "Diagnostic details require separate permission before they can be sent.".to_string(),
        );
    }

    let diagnostics = diagnostics.unwrap_or_default();
    Ok(json!({
        "consent": {
            "reportSubmission": true,
            "diagnostics": consent.diagnostics,
            "conversationTranscript": false,
        },
        "values": if consent.diagnostics {
            json!({
                "appVersion": clean_diagnostic(diagnostics.app_version),
                "platform": clean_diagnostic(diagnostics.platform),
                "osVersion": clean_diagnostic(diagnostics.os_version),
            })
        } else {
            serde_json::Value::Null
        },
    }))
}

async fn create_support_ticket(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<CreateSupportTicketRequest>,
) -> Response {
    let Some(service) = state.support().cloned() else {
        return error(
            "support_unavailable",
            "Kordi Support is not configured on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let category = input.category.trim().to_ascii_lowercase();
    if !matches!(category.as_str(), "question" | "issue" | "feedback") {
        return error(
            "invalid_support_ticket",
            "category must be question, issue, or feedback.",
            StatusCode::BAD_REQUEST,
        );
    }
    let subject = match clean_subject(&input.subject) {
        Ok(value) => value,
        Err(message) => {
            return error("invalid_support_ticket", &message, StatusCode::BAD_REQUEST);
        }
    };
    let description = match clean_required(&input.description, "description", DESCRIPTION_MAX_CHARS)
    {
        Ok(value) => value,
        Err(message) => {
            return error("invalid_support_ticket", &message, StatusCode::BAD_REQUEST);
        }
    };
    let client_submission_id = match clean_required(
        &input.client_submission_id,
        "clientSubmissionId",
        SUBMISSION_ID_MAX_CHARS,
    ) {
        Ok(value) => value,
        Err(message) => {
            return error("invalid_support_ticket", &message, StatusCode::BAD_REQUEST);
        }
    };
    match account_ticket_limit_reached(&state, &session.account_id, &client_submission_id).await {
        Ok(false) => {}
        Ok(true) => {
            return error(
                "support_rate_limited",
                "Too many support requests. Please wait before trying again.",
                StatusCode::TOO_MANY_REQUESTS,
            );
        }
        Err(error_value) => {
            eprintln!("[support] check ticket limit: {error_value}");
            return error(
                "server_error",
                "Could not validate the support request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }
    let session_id = match clean_optional(input.session_id.as_deref(), SESSION_ID_MAX_CHARS) {
        Ok(value) => value,
        Err(message) => {
            return error("invalid_support_ticket", &message, StatusCode::BAD_REQUEST);
        }
    };
    let diagnostics = match support_ticket_metadata(&input.consent, input.diagnostics) {
        Ok(value) => value,
        Err(message) => {
            return error(
                "support_consent_required",
                &message,
                StatusCode::BAD_REQUEST,
            );
        }
    };

    let ticket = match create_ticket(
        state.db_pool(),
        NewSupportTicket {
            account_id: &session.account_id,
            category: &category,
            subject: &subject,
            description: &description,
            session_id: session_id.as_deref(),
            diagnostics,
            client_submission_id: &client_submission_id,
        },
    )
    .await
    {
        Ok(ticket) => ticket,
        Err(error_value) => {
            eprintln!("[support] persist ticket: {error_value}");
            return error(
                "server_error",
                "Could not save the support request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if service.mail_delivery_enabled() && should_schedule_immediate_delivery(&ticket) {
        let state = state.clone();
        let ticket_id = ticket.ticket_id.clone();
        tokio::spawn(async move {
            service.deliver_ticket(state.db_pool(), &ticket_id).await;
        });
    }

    let status = if ticket.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (status, Json(ticket_response(ticket))).into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        clean_diagnostic, clean_required, clean_subject, should_schedule_immediate_delivery,
        support_ticket_metadata, SupportDiagnostics, SupportSubmissionConsent,
    };
    use crate::support::tickets::StoredSupportTicket;

    #[test]
    fn ticket_text_is_trimmed_and_bounded() {
        assert_eq!(clean_required("  Help  ", "subject", 20).unwrap(), "Help");
        assert!(clean_required("   ", "subject", 20).is_err());
        assert!(clean_required("too long", "subject", 3).is_err());
    }

    #[test]
    fn diagnostics_are_bounded_before_storage() {
        assert_eq!(
            clean_diagnostic(Some(" macOS ".into())).as_deref(),
            Some("macOS")
        );
        assert_eq!(clean_diagnostic(Some(" ".into())), None);
        assert_eq!(clean_diagnostic(Some("x".repeat(200))).unwrap().len(), 160);
    }

    #[test]
    fn ticket_subject_rejects_header_control_characters() {
        assert_eq!(
            clean_subject("  Group reply delay  ").unwrap(),
            "Group reply delay"
        );
        assert!(clean_subject("Injected\nBcc: attacker@example.com").is_err());
    }

    #[test]
    fn report_submission_requires_explicit_permission() {
        let result = support_ticket_metadata(
            &SupportSubmissionConsent {
                report_submission: false,
                diagnostics: false,
            },
            None,
        );

        assert_eq!(
            result.unwrap_err(),
            "Confirm permission before sending this report."
        );
    }

    #[test]
    fn diagnostics_require_separate_permission() {
        let result = support_ticket_metadata(
            &SupportSubmissionConsent {
                report_submission: true,
                diagnostics: false,
            },
            Some(SupportDiagnostics {
                platform: Some("desktop".into()),
                ..SupportDiagnostics::default()
            }),
        );

        assert_eq!(
            result.unwrap_err(),
            "Diagnostic details require separate permission before they can be sent."
        );
    }

    #[test]
    fn approved_metadata_records_scope_without_a_transcript() {
        let metadata = support_ticket_metadata(
            &SupportSubmissionConsent {
                report_submission: true,
                diagnostics: true,
            },
            Some(SupportDiagnostics {
                app_version: Some(" 0.0.1-beta.10 ".into()),
                platform: Some("desktop".into()),
                os_version: Some("macOS".into()),
            }),
        )
        .unwrap();

        assert_eq!(metadata["consent"]["reportSubmission"], true);
        assert_eq!(metadata["consent"]["diagnostics"], true);
        assert_eq!(metadata["consent"]["conversationTranscript"], false);
        assert_eq!(metadata["values"]["appVersion"], "0.0.1-beta.10");
    }

    #[test]
    fn only_a_new_ticket_schedules_immediate_delivery() {
        let ticket = |created, notification_status: &str| StoredSupportTicket {
            ticket_id: "support_test".into(),
            created_at: "2026-08-05T00:00:00Z".into(),
            notification_status: notification_status.into(),
            created,
        };

        assert!(should_schedule_immediate_delivery(&ticket(true, "pending")));
        assert!(!should_schedule_immediate_delivery(&ticket(
            false, "pending"
        )));
        assert!(!should_schedule_immediate_delivery(&ticket(false, "sent")));
    }
}
