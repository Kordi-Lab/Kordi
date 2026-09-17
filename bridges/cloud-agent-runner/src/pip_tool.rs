//! The one tool PiP's runs can call. The runner forwards every call to the
//! server, which binds it to the run's own conversation.

use serde_json::{json, Value};

pub const NAME: &str = "plan_card";

const DESCRIPTION: &str = "Turns a concrete group-chat plan (an event, meetup, or scheduling proposal) into a shared, stateful card instead of a one-off chat message. Use propose when the group has converged on a concrete title/time/place worth tracking: state='polling' if agreement still looks incomplete or details are unresolved, state='awaitingConfirmation' if a single option looks settled but has not been explicitly confirmed. Use rsvp to record one participant's yes/no without changing the card's overall state — a single non-organizer decline never cancels the plan; the card simply reflects that participant as declined while staying confirmed for everyone else. Use confirm only after explicit agreement (usually the organizer) to lock the card in; confirming an already-confirmed card at its current revision is a harmless no-op, never a duplicate. Use reopen to move a confirmed card back to awaitingConfirmation when new information — several declines, a scheduling conflict raised in chat — makes continuing genuinely unclear; always ask the group before calling confirm again. Use cancel only for a real end to the plan: the organizer canceling, or the group clearly agreeing to call it off. Never use cancel for a single attendee's decline — that is rsvp. Use options on a polling propose to open a vote between 2 to 4 concrete choices; members vote on the card, and vote records one participant's choice from what they said. confirm with optionId resolves the poll into that option's time and place. confirm, reopen, and cancel require the exact revision last seen for that card; a stale call is rejected rather than forking the card. rsvp and vote apply at any revision. Confirming a plan adds it to every attending member's Kordi calendar automatically; this tool never reads calendars.";

/// The tool as the model sees it.
pub fn definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": NAME,
            "description": DESCRIPTION,
            "parameters": parameters(),
        }
    })
}

fn parameters() -> Value {
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
