//! Shared, stateful "plan card" for group-chat coordination (propose / rsvp /
//! confirm / reopen / cancel). Any present participant's agent may call this —
//! it never touches personal data, only the shared card for the conversation.
//! Persistence and the actual state machine live in the injected runtime;
//! this module owns only the wire contract and input validation.

use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::text_result;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanCardState {
    Polling,
    AwaitingConfirmation,
    Confirmed,
    Canceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanCardRsvp {
    Pending,
    Yes,
    No,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardParticipant {
    pub participant_id: String,
    pub display_name: String,
    #[serde(default)]
    pub organizer: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardParticipantStatus {
    pub participant_id: String,
    pub display_name: String,
    pub organizer: bool,
    pub rsvp: PlanCardRsvp,
}

/// A vote option as the caller proposes it. Ids are optional; the server
/// assigns them in order when they are missing.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardOptionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

/// A vote option with the account ids that chose it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default)]
    pub votes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardSummary {
    pub event_id: String,
    pub revision: u64,
    pub state: PlanCardState,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_fields: Vec<String>,
    pub participants: Vec<PlanCardParticipantStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<PlanCardOption>,
    /// Human-readable audit note describing the effect of the call that
    /// produced this summary, e.g. "Riya declined; the plan stayed confirmed
    /// for the rest of the group." Surfaced to the model for its own
    /// action-message wording, not shown to participants verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardProposeRequest {
    pub conversation_id: String,
    /// Set together with `existing_revision` to update an already-open card
    /// for this conversation instead of starting a second, competing one.
    #[serde(default)]
    pub existing_event_id: Option<String>,
    #[serde(default)]
    pub existing_revision: Option<u64>,
    pub title: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    /// Only `Polling` or `AwaitingConfirmation` are valid on propose;
    /// `Confirmed`/`Canceled` only ever happen via their own actions.
    pub state: PlanCardState,
    #[serde(default)]
    pub unresolved_fields: Vec<String>,
    pub participants: Vec<PlanCardParticipant>,
    #[serde(default)]
    pub source_message_ids: Vec<String>,
    /// Concrete choices for a polling card. Members vote on the card; confirm
    /// with `option_id` resolves the poll into the card's own time and place.
    #[serde(default)]
    pub options: Vec<PlanCardOptionInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardRsvpRequest {
    pub event_id: String,
    /// Accepted for compatibility; an answer applies at any revision.
    #[serde(default)]
    pub revision: Option<u64>,
    pub participant_id: String,
    pub rsvp: PlanCardRsvp,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardConfirmRequest {
    pub event_id: String,
    pub revision: u64,
    pub confirmed_by: String,
    /// The winning option of a poll; its time and place become the card's.
    #[serde(default)]
    pub option_id: Option<String>,
}

/// One participant's vote for an option while the card is polling. A
/// participant holds one vote at a time; voting again moves it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardVoteRequest {
    pub event_id: String,
    #[serde(default)]
    pub revision: Option<u64>,
    pub participant_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardReopenRequest {
    pub event_id: String,
    pub revision: u64,
    /// Required: why a confirmed plan needs reconfirmation, e.g. "3 of 5
    /// declined within the hour." Becomes the audit note for the reopened
    /// card so participants see why it moved back to awaiting confirmation.
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardCancelRequest {
    pub event_id: String,
    pub revision: u64,
    pub canceled_by: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum PlanCardRequest {
    Propose(PlanCardProposeRequest),
    Rsvp(PlanCardRsvpRequest),
    Vote(PlanCardVoteRequest),
    Confirm(PlanCardConfirmRequest),
    Reopen(PlanCardReopenRequest),
    Cancel(PlanCardCancelRequest),
}

pub type PlanCardFuture = Pin<Box<dyn Future<Output = KordiResult<PlanCardSummary>> + Send>>;
pub type PlanCardFn = Arc<dyn Fn(PlanCardRequest) -> PlanCardFuture + Send + Sync>;

#[derive(Clone)]
pub struct PlanCardRuntime {
    pub call: PlanCardFn,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    message: String,
}

/// Credentials are host-supplied, never tool arguments. `request` already
/// serializes as the flat, action-tagged JSON body `/v1/cloud/plan_cards`
/// expects — see `PlanCardRequest`'s `#[serde(tag = "action", ...)]`.
pub fn http_runtime(api_base: String, token: String) -> PlanCardRuntime {
    PlanCardRuntime {
        call: Arc::new(move |request| {
            let api_base = api_base.clone();
            let token = token.clone();
            Box::pin(async move {
                let unavailable = || {
                    KordiError::Tool(
                        "Could not reach plan cards for this conversation. Try again.".to_string(),
                    )
                };
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(20))
                    .build()
                    .map_err(|_| unavailable())?;
                let response = client
                    .post(format!(
                        "{}/v1/cloud/plan_cards",
                        api_base.trim_end_matches('/')
                    ))
                    .bearer_auth(token)
                    .json(&request)
                    .send()
                    .await
                    .map_err(|_| unavailable())?;
                if !response.status().is_success() {
                    let message = response
                        .json::<ErrorBody>()
                        .await
                        .ok()
                        .map(|body| body.message)
                        .filter(|message| !message.trim().is_empty());
                    return Err(KordiError::Tool(message.unwrap_or_else(|| {
                        "Could not update the plan card. Try again.".to_string()
                    })));
                }
                response.json().await.map_err(|_| unavailable())
            })
        }),
    }
}

pub struct PlanCardTool;

#[async_trait]
impl Tool for PlanCardTool {
    fn allows_shared_requests(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "plan_card"
    }

    fn description(&self) -> &str {
        "Turns a concrete group-chat plan (an event, meetup, or scheduling proposal) into a shared, stateful card instead of a one-off chat message. Use propose when the group has converged on a concrete title/time/place worth tracking: state='polling' if agreement still looks incomplete or details are unresolved, state='awaitingConfirmation' if a single option looks settled but has not been explicitly confirmed. Use rsvp to record one participant's yes/no without changing the card's overall state — a single non-organizer decline never cancels the plan; the card simply reflects that participant as declined while staying confirmed for everyone else. Use confirm only after explicit agreement (usually the organizer) to lock the card in; confirming an already-confirmed card at its current revision is a harmless no-op, never a duplicate. Use reopen to move a confirmed card back to awaitingConfirmation when new information — several declines, a scheduling conflict raised in chat — makes continuing genuinely unclear; always ask the group before calling confirm again. Use cancel only for a real end to the plan: the organizer canceling, or the group clearly agreeing to call it off. Never use cancel for a single attendee's decline — that is rsvp. Use options on a polling propose to open a vote between 2 to 4 concrete choices; members vote on the card, and vote records one participant's choice from what they said. confirm with optionId resolves the poll into that option's time and place. confirm, reopen, and cancel require the exact revision last seen for that card; a stale call is rejected rather than forking the card. rsvp and vote apply at any revision. Confirming a plan adds it to every attending member's Kordi calendar automatically; this tool never reads calendars."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["propose", "rsvp", "vote", "confirm", "reopen", "cancel"],
                    "description": "Which plan-card operation to perform."
                },
                "options": {
                    "type": "array",
                    "description": "For a polling propose: 2 to 4 concrete choices the group votes on.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Optional stable id; assigned in order when omitted." },
                            "label": { "type": "string", "description": "Short choice text, e.g. 'Fri 7pm at Jordan's'." },
                            "startAt": { "type": "string", "description": "Optional RFC3339 start for this choice." },
                            "endAt": { "type": "string", "description": "Optional RFC3339 end for this choice." },
                            "location": { "type": "string" }
                        },
                        "required": ["label"],
                        "additionalProperties": false
                    }
                },
                "optionId": {
                    "type": "string",
                    "description": "For vote: the option chosen. For confirm: the winning option whose time and place become the plan's."
                },
                "conversationId": {
                    "type": "string",
                    "description": "Conversation this plan card belongs to. Required for propose."
                },
                "existingEventId": {
                    "type": "string",
                    "description": "If updating an already-open (not yet confirmed/canceled) card for this conversation instead of starting a new one, its event ID."
                },
                "existingRevision": {
                    "type": "number",
                    "description": "Revision of existingEventId being updated. Required whenever existingEventId is set."
                },
                "eventId": {
                    "type": "string",
                    "description": "Target plan card's event ID. Required for rsvp, confirm, reopen, and cancel."
                },
                "revision": {
                    "type": "number",
                    "description": "Revision this call was read at. Required for confirm, reopen, and cancel; a mismatch means the card changed and this call is rejected. Optional for rsvp and vote."
                },
                "title": {
                    "type": "string",
                    "description": "Plan title, e.g. 'Lunch at Ramen Izakaya'. Required for propose."
                },
                "startAt": {
                    "type": "string",
                    "description": "Optional RFC3339 start instant."
                },
                "endAt": {
                    "type": "string",
                    "description": "Optional RFC3339 end instant."
                },
                "location": {
                    "type": "string",
                    "description": "Optional location text."
                },
                "state": {
                    "type": "string",
                    "enum": ["polling", "awaitingConfirmation"],
                    "description": "Required for propose. 'polling' if agreement is still unclear or details are unresolved, 'awaitingConfirmation' if a single option looks settled but is not yet explicitly confirmed."
                },
                "unresolvedFields": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Names of fields still missing or undecided, e.g. ['location']."
                },
                "participants": {
                    "type": "array",
                    "description": "Required for propose: every participant this plan concerns.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "participantId": { "type": "string" },
                            "displayName": { "type": "string" },
                            "organizer": { "type": "boolean" }
                        },
                        "required": ["participantId", "displayName"],
                        "additionalProperties": false
                    }
                },
                "sourceMessageIds": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Chat message IDs this proposal was inferred from, for provenance."
                },
                "participantId": {
                    "type": "string",
                    "description": "Required for rsvp and vote: whose response or vote this is."
                },
                "rsvp": {
                    "type": "string",
                    "enum": ["yes", "no"],
                    "description": "Required for rsvp."
                },
                "note": {
                    "type": "string",
                    "description": "Optional short reason accompanying an rsvp."
                },
                "confirmedBy": {
                    "type": "string",
                    "description": "Required for confirm: participant ID confirming the plan."
                },
                "canceledBy": {
                    "type": "string",
                    "description": "Required for cancel: participant ID canceling the plan."
                },
                "reason": {
                    "type": "string",
                    "description": "Required for reopen (why it's ambiguous again); optional context for cancel."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::operator(ToolRiskLevel::Medium)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let request: PlanCardRequest = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid plan_card parameters: {err}")))?;
        validate_request(&request)?;

        let Some(runtime) = ctx.plan_card.clone() else {
            return Err(KordiError::Tool(
                "plan_card is only available in conversations where plan-card tracking is enabled"
                    .to_string(),
            ));
        };

        let summary = tokio::select! {
            result = (runtime.call)(request) => result?,
            _ = cancel.cancelled() => {
                return Err(KordiError::Tool("plan_card cancelled".to_string()));
            }
        };

        Ok(text_result(render_summary(&summary), Some(json!(summary))))
    }
}

fn validate_request(request: &PlanCardRequest) -> KordiResult<()> {
    match request {
        PlanCardRequest::Propose(request) => {
            if request.conversation_id.trim().is_empty() {
                return Err(KordiError::Tool(
                    "plan_card propose requires conversationId".to_string(),
                ));
            }
            if request.title.trim().is_empty() {
                return Err(KordiError::Tool(
                    "plan_card propose requires a non-empty title".to_string(),
                ));
            }
            if !matches!(
                request.state,
                PlanCardState::Polling | PlanCardState::AwaitingConfirmation
            ) {
                return Err(KordiError::Tool(
                    "plan_card propose state must be polling or awaitingConfirmation".to_string(),
                ));
            }
            if request.participants.is_empty() {
                return Err(KordiError::Tool(
                    "plan_card propose requires at least one participant".to_string(),
                ));
            }
            for participant in &request.participants {
                if participant.participant_id.trim().is_empty()
                    || participant.display_name.trim().is_empty()
                {
                    return Err(KordiError::Tool(
                        "plan_card propose participants require participantId and displayName"
                            .to_string(),
                    ));
                }
            }
            if request.existing_event_id.is_some() && request.existing_revision.is_none() {
                return Err(KordiError::Tool(
                    "plan_card propose requires existingRevision when existingEventId is set"
                        .to_string(),
                ));
            }
            Ok(())
        }
        PlanCardRequest::Rsvp(request) => {
            require_non_empty(&request.event_id, "eventId")?;
            require_non_empty(&request.participant_id, "participantId")?;
            if matches!(request.rsvp, PlanCardRsvp::Pending) {
                return Err(KordiError::Tool(
                    "plan_card rsvp must be yes or no, not pending".to_string(),
                ));
            }
            Ok(())
        }
        PlanCardRequest::Vote(request) => {
            require_non_empty(&request.event_id, "eventId")?;
            require_non_empty(&request.participant_id, "participantId")?;
            require_non_empty(&request.option_id, "optionId")
        }
        PlanCardRequest::Confirm(request) => {
            require_non_empty(&request.event_id, "eventId")?;
            require_non_empty(&request.confirmed_by, "confirmedBy")
        }
        PlanCardRequest::Reopen(request) => {
            require_non_empty(&request.event_id, "eventId")?;
            if request.reason.trim().is_empty() {
                return Err(KordiError::Tool(
                    "plan_card reopen requires a reason explaining the new ambiguity".to_string(),
                ));
            }
            Ok(())
        }
        PlanCardRequest::Cancel(request) => {
            require_non_empty(&request.event_id, "eventId")?;
            require_non_empty(&request.canceled_by, "canceledBy")
        }
    }
}

fn require_non_empty(value: &str, field: &str) -> KordiResult<()> {
    if value.trim().is_empty() {
        return Err(KordiError::Tool(format!("plan_card requires {field}")));
    }
    Ok(())
}

fn render_summary(summary: &PlanCardSummary) -> String {
    let mut lines = vec![format!(
        "Plan card {} ({:?}): {}",
        summary.event_id, summary.state, summary.title
    )];
    if let Some(start_at) = summary.start_at.as_deref() {
        lines.push(format!("Start: {start_at}"));
    }
    if let Some(location) = summary.location.as_deref() {
        lines.push(format!("Location: {location}"));
    }
    if !summary.unresolved_fields.is_empty() {
        lines.push(format!(
            "Unresolved: {}",
            summary.unresolved_fields.join(", ")
        ));
    }
    for option in &summary.options {
        lines.push(format!(
            "* {} [{}]: {} vote(s)",
            option.label,
            option.id,
            option.votes.len()
        ));
    }
    for participant in &summary.participants {
        let organizer = if participant.organizer {
            " (organizer)"
        } else {
            ""
        };
        lines.push(format!(
            "- {}{}: {:?}",
            participant.display_name, organizer, participant.rsvp
        ));
    }
    if let Some(note) = summary.note.as_deref() {
        lines.push(String::new());
        lines.push(note.to_string());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(plan_card: Option<PlanCardRuntime>) -> ToolContext {
        ToolContext {
            cwd: std::env::temp_dir(),
            artifacts_dir: std::env::temp_dir(),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            session_observation: None,
            task_operator: None,
            schedule_task: None,
            plan_card,
            execution_mode: crate::ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    fn sample_summary(state: PlanCardState, revision: u64) -> PlanCardSummary {
        PlanCardSummary {
            event_id: "plan_1".to_string(),
            revision,
            state,
            title: "Lunch at Ramen Izakaya".to_string(),
            start_at: Some("2026-06-14T12:30:00-07:00".to_string()),
            end_at: None,
            location: Some("Ramen Izakaya, 5th St".to_string()),
            unresolved_fields: Vec::new(),
            options: Vec::new(),
            participants: vec![
                PlanCardParticipantStatus {
                    participant_id: "jordan".to_string(),
                    display_name: "Jordan".to_string(),
                    organizer: true,
                    rsvp: PlanCardRsvp::Yes,
                },
                PlanCardParticipantStatus {
                    participant_id: "riya".to_string(),
                    display_name: "Riya".to_string(),
                    organizer: false,
                    rsvp: PlanCardRsvp::Pending,
                },
            ],
            note: None,
        }
    }

    #[test]
    fn allows_shared_requests_since_it_never_touches_personal_data() {
        assert!(PlanCardTool.allows_shared_requests());
    }

    #[test]
    fn request_deserializes_from_a_flat_action_tagged_object() {
        let request: PlanCardRequest = serde_json::from_value(json!({
            "action": "propose",
            "conversationId": "conv_1",
            "title": "Lunch",
            "state": "awaitingConfirmation",
            "participants": [
                {"participantId": "jordan", "displayName": "Jordan", "organizer": true}
            ]
        }))
        .unwrap();
        assert!(matches!(request, PlanCardRequest::Propose(_)));

        let request: PlanCardRequest = serde_json::from_value(
            json!({"action": "cancel", "eventId": "plan_1", "revision": 2, "canceledBy": "jordan"}),
        )
        .unwrap();
        assert!(matches!(request, PlanCardRequest::Cancel(_)));
    }

    #[tokio::test]
    async fn propose_rejects_confirmed_or_canceled_initial_state() {
        let ctx = context(None);
        for state in ["confirmed", "canceled"] {
            let params = json!({
                "action": "propose",
                "conversationId": "conv_1",
                "title": "Lunch",
                "state": state,
                "participants": [{"participantId": "jordan", "displayName": "Jordan"}]
            });
            let error = PlanCardTool
                .execute(params, &ctx, CancellationToken::new())
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("polling or awaitingConfirmation")
            );
        }
    }

    #[tokio::test]
    async fn propose_rejects_empty_title_and_missing_participants() {
        let ctx = context(None);
        let missing_title = PlanCardTool
            .execute(
                json!({"action": "propose", "conversationId": "conv_1", "title": "  ", "state": "polling", "participants": [{"participantId": "j", "displayName": "Jordan"}]}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(missing_title.to_string().contains("title"));

        let missing_participants = PlanCardTool
            .execute(
                json!({"action": "propose", "conversationId": "conv_1", "title": "Lunch", "state": "polling", "participants": []}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(
            missing_participants
                .to_string()
                .contains("at least one participant")
        );
    }

    #[tokio::test]
    async fn rsvp_rejects_pending_since_pending_is_not_a_settable_response() {
        let ctx = context(None);
        let error = PlanCardTool
            .execute(
                json!({"action": "rsvp", "eventId": "plan_1", "revision": 1, "participantId": "riya", "rsvp": "pending"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("yes or no"));
    }

    #[tokio::test]
    async fn reopen_requires_a_reason() {
        let ctx = context(None);
        let error = PlanCardTool
            .execute(
                json!({"action": "reopen", "eventId": "plan_1", "revision": 3, "reason": ""}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("reason"));
    }

    #[tokio::test]
    async fn missing_runtime_is_a_clear_error_not_a_panic() {
        let ctx = context(None);
        let error = PlanCardTool
            .execute(
                json!({"action": "confirm", "eventId": "plan_1", "revision": 1, "confirmedBy": "jordan"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("plan_card is only available"));
    }

    #[tokio::test]
    async fn successful_call_dispatches_through_the_runtime_and_returns_its_summary() {
        let seen_action = Arc::new(std::sync::Mutex::new(None));
        let seen_action_clone = seen_action.clone();
        let ctx = context(Some(PlanCardRuntime {
            call: Arc::new(move |request| {
                *seen_action_clone.lock().unwrap() = Some(match &request {
                    PlanCardRequest::Confirm(_) => "confirm",
                    _ => "other",
                });
                Box::pin(async move { Ok(sample_summary(PlanCardState::Confirmed, 2)) })
            }),
        }));

        let result = PlanCardTool
            .execute(
                json!({"action": "confirm", "eventId": "plan_1", "revision": 1, "confirmedBy": "jordan"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(seen_action.lock().unwrap().as_deref(), Some("confirm"));
        assert_eq!(
            result.details.unwrap()["state"],
            json!("confirmed"),
            "details should carry the machine-readable summary the client renders the card from"
        );
    }

    #[tokio::test]
    async fn confirming_an_already_confirmed_card_is_a_harmless_no_op_through_the_runtime() {
        // The tool itself is stateless; idempotency on a matching revision is the
        // runtime's job. This asserts the tool does not add its own blocking
        // logic that would prevent a no-op confirm from reaching the runtime.
        let ctx = context(Some(PlanCardRuntime {
            call: Arc::new(|_request| {
                Box::pin(async move {
                    let mut summary = sample_summary(PlanCardState::Confirmed, 2);
                    summary.note = Some("Already confirmed; no change.".to_string());
                    Ok(summary)
                })
            }),
        }));

        let result = PlanCardTool
            .execute(
                json!({"action": "confirm", "eventId": "plan_1", "revision": 2, "confirmedBy": "jordan"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            result.details.unwrap()["note"],
            json!("Already confirmed; no change.")
        );
    }

    #[tokio::test]
    async fn cancellation_token_short_circuits_a_slow_runtime() {
        let cancel = CancellationToken::new();
        let ctx = context(Some(PlanCardRuntime {
            call: Arc::new(|_request| {
                Box::pin(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    unreachable!("runtime should have been cancelled first")
                })
            }),
        }));

        let cancel_clone = cancel.clone();
        let handle = tokio::spawn(async move {
            PlanCardTool
                .execute(
                    json!({"action": "confirm", "eventId": "plan_1", "revision": 1, "confirmedBy": "jordan"}),
                    &ctx,
                    cancel_clone,
                )
                .await
        });
        cancel.cancel();
        let error = handle.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("cancelled"));
    }
}
