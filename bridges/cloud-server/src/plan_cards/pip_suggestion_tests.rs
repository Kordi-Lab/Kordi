//! PiP only suggests: its answers, votes, and plan decisions wait for a
//! person, and approving applies them as that person at the revision PiP saw.

use std::collections::BTreeSet;

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::models::{PlanCardRow, PlanCardRsvp, PlanCardState};
use super::routes::{dispatch, dispatch_row, Actor};
use super::suggestions::Dispatched;
use super::tests::{seed_account, seed_conversation};
use crate::cloud_agent_runtime::agent_actions::decide_action;
use crate::events::EventBus;
use crate::server::ServerState;

struct Fixture {
    pool: PgPool,
    state: ServerState,
    conversation: Uuid,
    pip: String,
    jordan: String,
    maya: String,
    riya: String,
}

async fn fixture() -> Fixture {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let suffix = Uuid::new_v4().simple().to_string();
    let [pip, jordan, maya, riya] =
        ["pip", "jordan", "maya", "riya"].map(|name| format!("{name}-{suffix}"));
    for account in [&pip, &jordan, &maya, &riya] {
        seed_account(&pool, account).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &jordan, &[&jordan, &maya, &riya, &pip]).await;
    Fixture {
        state: ServerState::new(pool.clone(), EventBus::noop()),
        pool,
        conversation,
        pip,
        jordan,
        maya,
        riya,
    }
}

impl Fixture {
    fn pip_run(&self, represented: &[&String]) -> Actor {
        Actor {
            account_id: self.pip.clone(),
            on_behalf_of_conversation: Some(self.conversation),
            represented_accounts: represented
                .iter()
                .map(|account| account.to_string())
                .collect(),
        }
    }

    fn member(&self, account: &str) -> Actor {
        Actor {
            account_id: account.to_string(),
            on_behalf_of_conversation: None,
            represented_accounts: BTreeSet::new(),
        }
    }

    async fn propose(&self, options: Value) -> PlanCardRow {
        let request = serde_json::from_value(json!({
            "action": "propose", "conversationId": self.conversation, "title": "Dinner",
            "startAt": (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339(),
            "state": if options.as_array().is_some_and(|o| !o.is_empty()) { "polling" } else { "awaitingConfirmation" },
            "options": options,
            "participants": [
                {"participantId": self.jordan, "displayName": "Jordan", "organizer": true},
                {"participantId": self.maya, "displayName": "Maya"},
                {"participantId": self.riya, "displayName": "Riya"},
            ],
        }))
        .unwrap();
        match dispatch(&self.pool, &self.pip_run(&[]), request).await {
            Ok(Dispatched::Applied(row)) => row,
            _ => panic!("PiP proposes cards directly"),
        }
    }

    async fn suggest(&self, represented: &[&String], request: Value) -> (Uuid, PlanCardRow) {
        let request = serde_json::from_value(request).unwrap();
        match dispatch(&self.pool, &self.pip_run(represented), request).await {
            Ok(Dispatched::Suggested { action_id, row, .. }) => (action_id, row),
            Ok(Dispatched::Applied(_)) => panic!("PiP must only suggest"),
            Err(rejection) => panic!("suggestion refused: {}", rejection.status()),
        }
    }

    async fn decide(&self, account: &str, action_id: Uuid, approve: bool) -> (u16, Value) {
        match decide_action(&self.state, account, action_id, approve).await {
            Ok(body) => (200, body),
            Err(response) => {
                let status = response.status().as_u16();
                let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                    .await
                    .unwrap();
                (
                    status,
                    serde_json::from_slice(&bytes).unwrap_or(Value::Null),
                )
            }
        }
    }

    async fn status(&self, action_id: Uuid) -> String {
        let (status,): (String,) =
            query_as("SELECT status FROM cloud_agent_pending_actions WHERE action_id = $1")
                .bind(action_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        status
    }

    async fn card(&self, event_id: &str) -> PlanCardRow {
        super::store::load(&self.pool, event_id)
            .await
            .unwrap()
            .unwrap()
    }

    /// Saved calendar events the plan has produced for anyone.
    async fn calendar_rows(&self, event_id: &str) -> i64 {
        let (count,): (i64,) =
            query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id = $1")
                .bind(format!("plan:{event_id}"))
                .fetch_one(&self.pool)
                .await
                .unwrap();
        count
    }
}

fn rsvp_of(row: &PlanCardRow, account: &str) -> PlanCardRsvp {
    row.participants
        .iter()
        .find(|participant| participant.account_id == account)
        .unwrap()
        .rsvp
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn answers_wait_for_the_member_and_apply_as_them() {
    let f = fixture().await;
    let card = f.propose(json!([])).await;
    // The organizer starts pending, with a yes suggestion waiting for them.
    assert_eq!(rsvp_of(&card, &f.jordan), PlanCardRsvp::Pending);
    let organizer: Vec<(Uuid, String)> = query_as(
        "SELECT action_id, subject->>'rsvp' FROM cloud_agent_pending_actions
         WHERE event_id = $1 AND kind = 'plan_rsvp' AND approver_account_id = $2
           AND status = 'pending'",
    )
    .bind(&card.event_id)
    .bind(&f.jordan)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    assert_eq!(organizer.len(), 1);
    assert_eq!(organizer[0].1, "yes");

    // Only members who wrote in the new messages can get a suggestion.
    let request = json!({"action": "rsvp", "eventId": card.event_id,
        "participantId": f.riya, "rsvp": "yes"});
    let refused = dispatch(
        &f.pool,
        &f.pip_run(&[&f.maya]),
        serde_json::from_value(request).unwrap(),
    )
    .await;
    assert_eq!(refused.err().unwrap().status(), 403);

    let (action, unchanged) = f
        .suggest(
            &[&f.maya],
            json!({"action": "rsvp", "eventId": card.event_id,
                "participantId": f.maya, "rsvp": "yes"}),
        )
        .await;
    assert_eq!(unchanged.revision, card.revision);
    let current = f.card(&card.event_id).await;
    assert_eq!(current.revision, card.revision);
    assert_eq!(rsvp_of(&current, &f.maya), PlanCardRsvp::Pending);

    // Nobody else can decide it.
    assert_eq!(f.decide(&f.riya, action, true).await.0, 404);
    assert_eq!(f.decide(&f.jordan, action, true).await.0, 404);
    let (status, body) = f.decide(&f.maya, action, true).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["action"]["status"], "applied");
    assert_eq!(body["planCard"]["revision"], card.revision + 1);
    let applied = f.card(&card.event_id).await;
    assert_eq!(rsvp_of(&applied, &f.maya), PlanCardRsvp::Yes);
    // Repeating the same decision returns the current state.
    let (status, repeated) = f.decide(&f.maya, action, true).await;
    assert_eq!(
        (status, &repeated["action"]["status"]),
        (200, &json!("applied"))
    );
    assert_eq!(f.decide(&f.maya, action, false).await.0, 409);

    // A declined suggestion changes nothing.
    let (decline, _) = f
        .suggest(
            &[&f.maya],
            json!({"action": "rsvp", "eventId": card.event_id,
                "participantId": f.maya, "rsvp": "no", "note": "Away"}),
        )
        .await;
    let (status, body) = f.decide(&f.maya, decline, false).await;
    assert_eq!(
        (status, &body["action"]["status"]),
        (200, &json!("declined"))
    );
    assert_eq!(body["planCard"], Value::Null);
    assert_eq!(f.card(&card.event_id).await.revision, applied.revision);

    // A member answering on the card settles PiP's matching suggestion.
    let (settled, _) = f
        .suggest(
            &[&f.maya],
            json!({"action": "rsvp", "eventId": card.event_id,
                "participantId": f.maya, "rsvp": "no"}),
        )
        .await;
    dispatch_row(
        &f.pool,
        &f.member(&f.maya),
        serde_json::from_value(json!({"action": "rsvp", "eventId": card.event_id,
            "participantId": f.maya, "rsvp": "yes"}))
        .unwrap(),
    )
    .await
    .unwrap_or_else(|_| panic!("own answer"));
    super::suggestions::supersede_after_member_action(&f.pool, &f.maya, "rsvp", &card.event_id)
        .await
        .unwrap();
    assert_eq!(f.status(settled).await, "superseded");
    assert_eq!(f.decide(&f.maya, settled, true).await.0, 409);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn votes_and_plan_decisions_carry_the_revision_pip_saw() {
    let f = fixture().await;
    let saturday = (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339();
    let card = f
        .propose(json!([
            {"id": "opt_sat", "label": "Saturday", "startAt": saturday},
            {"id": "opt_sun", "label": "Sunday",
             "startAt": (chrono::Utc::now() + chrono::Duration::days(4)).to_rfc3339()},
        ]))
        .await;
    let (vote, _) = f
        .suggest(
            &[&f.riya],
            json!({"action": "vote", "eventId": card.event_id,
                "participantId": f.riya, "optionId": "opt_sat"}),
        )
        .await;
    let (status, body) = f.decide(&f.riya, vote, true).await;
    assert_eq!(status, 200, "{body}");
    let voted = f.card(&card.event_id).await;
    assert_eq!(voted.options[0].votes, vec![f.riya.clone()]);

    // A confirm suggested at an older revision goes stale.
    let (stale, _) = f
        .suggest(
            &[],
            json!({"action": "confirm", "eventId": card.event_id, "revision": voted.revision,
                "confirmedBy": f.jordan, "optionId": "opt_sat"}),
        )
        .await;
    let subject: (Value,) =
        query_as("SELECT subject FROM cloud_agent_pending_actions WHERE action_id = $1")
            .bind(stale)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(subject.0["revision"], voted.revision);
    assert_eq!(subject.0["optionId"], "opt_sat");
    // Suggesting a confirmation changes neither the card nor anyone's calendar.
    let unchanged = f.card(&card.event_id).await;
    assert_eq!(
        (unchanged.revision, unchanged.state),
        (voted.revision, PlanCardState::Polling)
    );
    assert_eq!(f.calendar_rows(&card.event_id).await, 0);
    // Members who are not plan managers never see plan decisions.
    assert_eq!(f.decide(&f.maya, stale, true).await.0, 404);
    dispatch_row(
        &f.pool,
        &f.member(&f.jordan),
        serde_json::from_value(json!({"action": "rsvp", "eventId": card.event_id,
            "participantId": f.jordan, "rsvp": "yes"}))
        .unwrap(),
    )
    .await
    .unwrap_or_else(|_| panic!("organizer answers"));
    let (status, body) = f.decide(&f.jordan, stale, true).await;
    assert_eq!((status, &body["errorCode"]), (409, &json!("plan_changed")));
    assert_eq!(f.status(stale).await, "superseded");
    assert_eq!(f.card(&card.event_id).await.state, PlanCardState::Polling);

    // At the current revision, the organizer's approval confirms the plan.
    let current = f.card(&card.event_id).await;
    let (confirm, _) = f
        .suggest(
            &[],
            json!({"action": "confirm", "eventId": card.event_id, "revision": current.revision,
                "confirmedBy": f.jordan, "optionId": "opt_sat"}),
        )
        .await;
    let (status, body) = f.decide(&f.jordan, confirm, true).await;
    assert_eq!(status, 200, "{body}");
    let confirmed = f.card(&card.event_id).await;
    assert_eq!(confirmed.state, PlanCardState::Confirmed);
    assert_eq!(body["planCard"]["revision"], confirmed.revision);

    // Reopen and cancel suggestions store the revision too; a newer decision
    // replaces an older one, and declining leaves the card as it is.
    let (reopen, _) = f
        .suggest(
            &[],
            json!({"action": "reopen", "eventId": card.event_id,
                "revision": confirmed.revision, "reason": "Riya is sick"}),
        )
        .await;
    let (cancel, _) = f
        .suggest(
            &[],
            json!({"action": "cancel", "eventId": card.event_id, "revision": confirmed.revision,
                "canceledBy": f.jordan, "reason": "Rain"}),
        )
        .await;
    assert_eq!(f.status(reopen).await, "superseded");
    let (revision, reason): (i64, String) = query_as(
        "SELECT (subject->>'revision')::bigint, subject->>'reason'
         FROM cloud_agent_pending_actions WHERE action_id = $1",
    )
    .bind(cancel)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!((revision, reason.as_str()), (confirmed.revision, "Rain"));
    let (status, body) = f.decide(&f.jordan, cancel, false).await;
    assert_eq!(
        (status, &body["action"]["status"]),
        (200, &json!("declined"))
    );
    assert_eq!(f.card(&card.event_id).await.state, PlanCardState::Confirmed);

    let (reopen, _) = f
        .suggest(
            &[],
            json!({"action": "reopen", "eventId": card.event_id,
                "revision": confirmed.revision, "reason": "Riya is sick"}),
        )
        .await;
    let (status, body) = f.decide(&f.jordan, reopen, true).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        f.card(&card.event_id).await.state,
        PlanCardState::AwaitingConfirmation
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn expired_suggestions_close_and_listing_follows_visibility() {
    let f = fixture().await;
    let card = f.propose(json!([])).await;
    let (action, _) = f
        .suggest(
            &[&f.maya],
            json!({"action": "rsvp", "eventId": card.event_id,
                "participantId": f.maya, "rsvp": "yes"}),
        )
        .await;
    let listed = crate::cloud_agent_runtime::agent_actions::list_for(&f.pool, &f.maya, None)
        .await
        .unwrap();
    assert!(listed.iter().any(|row| row.action_id == action));
    let others = crate::cloud_agent_runtime::agent_actions::list_for(&f.pool, &f.riya, None)
        .await
        .unwrap();
    assert!(others.iter().all(|row| row.action_id != action));

    sqlx_core::query::query(
        "UPDATE cloud_agent_pending_actions SET expires_at = now() - interval '1 second'
         WHERE action_id = $1",
    )
    .bind(action)
    .execute(&f.pool)
    .await
    .unwrap();
    let listed = crate::cloud_agent_runtime::agent_actions::list_for(&f.pool, &f.maya, None)
        .await
        .unwrap();
    assert!(listed.iter().all(|row| row.action_id != action));
    let (status, body) = f.decide(&f.maya, action, true).await;
    assert_eq!(
        (status, &body["errorCode"]),
        (409, &json!("agent_action_closed"))
    );
    assert_eq!(f.status(action).await, "expired");
    assert_eq!(
        rsvp_of(&f.card(&card.event_id).await, &f.maya),
        PlanCardRsvp::Pending
    );
}
