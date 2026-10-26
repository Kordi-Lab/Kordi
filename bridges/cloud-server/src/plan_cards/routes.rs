use std::{collections::BTreeSet, sync::Arc};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::{
    auth::routes::{cloud_session_middleware, CloudSession},
    server::ServerState,
};

use super::models::{PlanCardProposeArgs, PlanCardRow, PlanCardRsvp, PlanCardStoreError};
use super::store;
use super::wire::{blank_to_none, error, store_error, Rejection, Request};

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/plan_cards", post(handle))
        .route("/v1/cloud/plan_cards/:event_id", get(snapshot))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

/// Read-only recovery for a client that missed a card update. Membership is
/// checked on every read, including when the caller knows an old event id.
async fn snapshot(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(event_id): Path<String>,
) -> Response {
    let row = match store::load(state.db_pool(), &event_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return *store_error(super::models::PlanCardStoreError::NotFound),
        Err(err) => return *store_error(err.into()),
    };
    let Ok(conversation_id) = Uuid::parse_str(&row.conversation_id) else {
        return *store_error(super::models::PlanCardStoreError::Forbidden);
    };
    if !is_active_member(state.db_pool(), conversation_id, &session.account_id).await {
        return *store_error(super::models::PlanCardStoreError::Forbidden);
    }
    Json(row).into_response()
}

async fn handle(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<Request>,
) -> Response {
    let actor = Actor {
        account_id: session.account_id.clone(),
        on_behalf_of_conversation: None,
        represented_accounts: BTreeSet::new(),
    };
    match dispatch_row(state.db_pool(), &actor, request).await {
        Ok(row) => {
            // A member's response belongs on the card, not in the chat: the
            // System agent's message that carries this card is refreshed in
            // place for everyone, with no new line and no model run. The System
            // agent is not in direct chats or Grounding groups, so it has
            // nothing there.
            if let Some(system_agent) = state.system_agent() {
                let system_agent_account = system_agent.config().account_id.as_str();
                let in_chat = match Uuid::parse_str(&row.conversation_id) {
                    Ok(id) => is_active_member(state.db_pool(), id, system_agent_account).await,
                    Err(_) => false,
                };
                if in_chat {
                    let synced = crate::system_agent::cards::sync_card_messages(
                        state.db_pool(),
                        system_agent_account,
                        &row,
                    )
                    .await;
                    if let Err(error) = synced {
                        eprintln!(
                            "[system-agent] Could not update the plan card messages: {error}"
                        );
                    }
                }
            }
            // An organizer who carries the card in their own message (a Meet
            // from Common ground) sees it refreshed the same way.
            for organizer in row.participants.iter().filter(|p| p.organizer) {
                if let Err(error) = crate::system_agent::cards::refresh_card_carriers(
                    state.db_pool(),
                    &organizer.account_id,
                    &row,
                )
                .await
                {
                    eprintln!("[plan-card] Could not update the organizer's card: {error}");
                }
            }
            Json(row).into_response()
        }
        Err(response) => *response,
    }
}

/// Who is acting on a card. A signed-in member acts for themselves only. A
/// service agent (the System agent) acts inside one conversation and may record
/// another active member's RSVP, confirmation, or cancellation from what that
/// member said in the chat.
pub(crate) struct Actor {
    pub account_id: String,
    pub on_behalf_of_conversation: Option<Uuid>,
    pub represented_accounts: BTreeSet<String>,
}

async fn is_active_member(pool: &PgPool, conversation_id: Uuid, account_id: &str) -> bool {
    query_as::<_, (bool,)>(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map(|row| row.0)
    .unwrap_or(false)
}

/// Validates that `acting_for` may be acted on by this actor: either it is the
/// actor itself, or the actor is a service agent and `acting_for` is an active
/// member of the actor's conversation.
async fn may_act_for(pool: &PgPool, actor: &Actor, acting_for: &str) -> bool {
    if acting_for == actor.account_id {
        return true;
    }
    match actor.on_behalf_of_conversation {
        Some(conversation_id) if actor.represented_accounts.contains(acting_for) => {
            is_active_member(pool, conversation_id, acting_for).await
        }
        Some(_) => false,
        None => false,
    }
}

/// A System agent run acts only on cards in its own conversation, whatever
/// event id the chat put in front of it. Members are checked against the card's
/// own conversation by the store.
async fn require_in_scope(pool: &PgPool, actor: &Actor, event_id: &str) -> Result<(), Rejection> {
    let Some(scope) = actor.on_behalf_of_conversation else {
        return Ok(());
    };
    let card: Option<(Uuid,)> =
        query_as("SELECT conversation_id FROM cloud_plan_cards WHERE event_id = $1")
            .bind(event_id)
            .fetch_optional(pool)
            .await
            .map_err(|err| store_error(err.into()))?;
    match card {
        Some((conversation_id,)) if conversation_id == scope => Ok(()),
        Some(_) => Err(error(
            "plan_card_forbidden",
            "This run may only manage plan cards in its own conversation.",
            StatusCode::FORBIDDEN,
        )),
        None => Err(store_error(super::models::PlanCardStoreError::NotFound)),
    }
}

/// A member deciding a plan for everyone (confirming, reopening, or canceling
/// it) must be its organizer or an owner or admin of the chat. The System
/// agent's runs decide from what members said in the chat.
async fn require_plan_manager(
    pool: &PgPool,
    account_id: &str,
    event_id: &str,
) -> Result<(), Rejection> {
    let allowed: (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_plan_card_participants
                       WHERE event_id = $1 AND account_id = $2 AND organizer)
             OR EXISTS(SELECT 1 FROM cloud_plan_cards card
                       JOIN cloud_chat_conversation_members member
                         ON member.conversation_id = card.conversation_id
                       WHERE card.event_id = $1 AND member.account_id = $2
                         AND member.membership_state = 'active'
                         AND member.role IN ('owner', 'admin'))",
    )
    .bind(event_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map_err(|err| store_error(err.into()))?;
    if allowed.0 {
        Ok(())
    } else {
        Err(forbidden(
            "Only the plan's organizer or a chat admin can decide this plan.",
        ))
    }
}

/// A signed-in member never opens a card; the System agent does. The organizer
/// of a card may revise it (a new time, place, or title) for the same people
/// while it is still open. The store rejects a confirmed or canceled card and a
/// stale revision, and resets answers when the time or place changes.
async fn organizer_revision(
    pool: &PgPool,
    account_id: &str,
    mut args: PlanCardProposeArgs,
) -> Result<PlanCardProposeArgs, Rejection> {
    let Some(event_id) = args.existing_event_id.as_deref() else {
        return Err(forbidden("Plan cards are proposed by the System agent."));
    };
    if !is_active_member(pool, args.conversation_id, account_id).await {
        return Err(store_error(PlanCardStoreError::Forbidden));
    }
    let card = store::load(pool, event_id)
        .await
        .map_err(|err| store_error(err.into()))?
        .filter(|card| card.conversation_id == args.conversation_id.to_string())
        .ok_or_else(|| store_error(PlanCardStoreError::NotFound))?;
    let organizes = card
        .participants
        .iter()
        .any(|participant| participant.organizer && participant.account_id == account_id);
    if !organizes {
        return Err(forbidden("Only the organizer can change this plan."));
    }
    let current: BTreeSet<&str> = card
        .participants
        .iter()
        .map(|participant| participant.account_id.as_str())
        .collect();
    let requested: BTreeSet<&str> = args
        .participants
        .iter()
        .map(|participant| participant.account_id.as_str())
        .collect();
    if current != requested || requested.len() != args.participants.len() {
        return Err(error(
            "invalid_participants",
            "Changing a plan keeps the same people.",
            StatusCode::BAD_REQUEST,
        ));
    }
    // The organizer stays the organizer; nobody else becomes one.
    for participant in &mut args.participants {
        participant.organizer = participant.account_id == account_id;
    }
    Ok(args)
}

fn forbidden(message: &str) -> Rejection {
    error("plan_card_forbidden", message, StatusCode::FORBIDDEN)
}

/// Applies one request and returns the resulting card, or the error response to
/// send back. The member route and the System agent's runner both act through
/// here.
pub(crate) async fn dispatch_row(
    pool: &PgPool,
    actor: &Actor,
    request: Request,
) -> Result<PlanCardRow, Rejection> {
    apply(pool, actor, request).await
}

async fn apply(pool: &PgPool, actor: &Actor, request: Request) -> Result<PlanCardRow, Rejection> {
    let event_id = match &request {
        Request::Propose(_) => None,
        Request::Rsvp { event_id, .. }
        | Request::Vote { event_id, .. }
        | Request::Confirm { event_id, .. }
        | Request::Reopen { event_id, .. }
        | Request::Cancel { event_id, .. } => Some(event_id.clone()),
    };
    if let Some(event_id) = event_id {
        require_in_scope(pool, actor, &event_id).await?;
    }
    match request {
        Request::Propose(propose) if actor.on_behalf_of_conversation.is_none() => {
            let args = propose.into_args(None)?;
            let args = organizer_revision(pool, &actor.account_id, args).await?;
            store::propose(pool, &actor.account_id, args)
                .await
                .map_err(store_error)
        }
        Request::Propose(propose) => {
            let mut args = propose.into_args(actor.on_behalf_of_conversation)?;
            // The System agent manages the card but never attends it. The model
            // sometimes lists the agent among the participants; never store it
            // as one.
            args.participants
                .retain(|participant| participant.account_id != actor.account_id);
            if args.participants.is_empty() {
                return Err(error(
                    "invalid_participants",
                    "At least one participant is required.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            store::propose(pool, &actor.account_id, args)
                .await
                .map_err(store_error)
        }
        Request::Vote {
            event_id,
            participant_id,
            option_id,
            ..
        } => {
            if !may_act_for(pool, actor, &participant_id).await {
                return Err(forbidden("You can only cast your own vote."));
            }
            store::vote(pool, &event_id, &participant_id, option_id.trim())
                .await
                .map_err(store_error)
        }
        Request::Rsvp {
            event_id,
            participant_id,
            rsvp,
            note,
            ..
        } => {
            let rsvp = PlanCardRsvp::from_db_str(&rsvp)
                .filter(|rsvp| !matches!(rsvp, PlanCardRsvp::Pending))
                .ok_or_else(|| {
                    error(
                        "invalid_rsvp",
                        "rsvp must be yes or no.",
                        StatusCode::BAD_REQUEST,
                    )
                })?;
            // A member records only their own RSVP. The System agent may record
            // another active member's RSVP from what that member said in the
            // chat.
            if !may_act_for(pool, actor, &participant_id).await {
                return Err(forbidden("You can only record your own RSVP."));
            }
            let note = blank_to_none(note);
            store::rsvp(pool, &event_id, &participant_id, rsvp, note.as_deref())
                .await
                .map_err(store_error)
        }
        Request::Confirm {
            event_id,
            revision,
            confirmed_by,
            option_id,
        } => {
            if !may_act_for(pool, actor, &confirmed_by).await {
                return Err(forbidden(
                    "confirmedBy must match the authenticated account.",
                ));
            }
            require_plan_manager(pool, &confirmed_by, &event_id).await?;
            let option_id = blank_to_none(option_id);
            store::confirm(
                pool,
                &event_id,
                revision,
                &confirmed_by,
                option_id.as_deref(),
                None,
            )
            .await
            .map_err(store_error)
        }
        Request::Reopen {
            event_id,
            revision,
            reason,
        } => {
            if reason.trim().is_empty() {
                return Err(error(
                    "invalid_reason",
                    "reason is required to reopen a plan card.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            if actor.on_behalf_of_conversation.is_none() {
                require_plan_manager(pool, &actor.account_id, &event_id).await?;
            }
            store::reopen(pool, &event_id, revision, &actor.account_id, &reason)
                .await
                .map_err(store_error)
        }
        Request::Cancel {
            event_id,
            revision,
            canceled_by,
            reason,
        } => {
            if !may_act_for(pool, actor, &canceled_by).await {
                return Err(forbidden(
                    "canceledBy must match the authenticated account.",
                ));
            }
            require_plan_manager(pool, &canceled_by, &event_id).await?;
            store::cancel(pool, &event_id, revision, &canceled_by, reason.as_deref())
                .await
                .map_err(store_error)
        }
    }
}
