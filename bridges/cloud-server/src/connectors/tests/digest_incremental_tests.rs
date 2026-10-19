//! Cheaper digest runs (issue 1870): automatic runs send only the changes
//! and a full rebuild runs once a day or on request, a quick check decides
//! whether a message is urgent enough to update at once, and digest runs ask
//! for a fast model with low thinking unless the owner chooses otherwise.

use super::digest_cadence_tests::{fixture, Fixture};
use super::*;
use crate::digest::changes::note_message;
use crate::digest::store::{self as digest_store, Trigger};

impl Fixture {
    /// The newest digest run: its frozen input, route and system prompt.
    async fn last_run(&self) -> (Value, Value, String) {
        let (prompt, route, system): (String, Value, String) = query_as(
            "SELECT prompt, runtime_route_json, system_prompt FROM cloud_agent_fallback_runs \
             WHERE owner_account_id=$1 AND run_id LIKE 'digest\\_%' \
             ORDER BY created_at DESC, run_id DESC LIMIT 1",
        )
        .bind(&self.owner)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (serde_json::from_str(&prompt).unwrap(), route, system)
    }

    async fn active_run(&self) -> Option<String> {
        query_as::<_, (Option<String>,)>(
            "SELECT active_run_id FROM cloud_account_digests WHERE account_id=$1",
        )
        .bind(&self.owner)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .0
    }

    /// Leases the active run to a test runner and completes it with `reply`.
    async fn complete_active(&self, reply: &str) {
        let run = self.active_run().await.expect("an active run");
        query(
            "UPDATE cloud_agent_fallback_runs SET status='leased', claimed_by='test-runner', \
             lease_expires_at=$2 WHERE run_id=$1",
        )
        .bind(&run)
        .bind((Utc::now() + ChronoDuration::minutes(5)).to_rfc3339())
        .execute(&self.pool)
        .await
        .unwrap();
        crate::digest::complete(&self.pool, &run, "test-runner", reply)
            .await
            .unwrap();
    }

    async fn set(&self, assignment: &str) {
        query(&format!(
            "UPDATE cloud_account_digests SET {assignment} WHERE account_id=$1"
        ))
        .bind(&self.owner)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn news(&self, text: &str) {
        let message = self.message(&self.author, text).await;
        note_message(&self.pool, "message.created", &message)
            .await
            .unwrap();
    }
}

const EMPTY: &str = r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[]}"#;

#[tokio::test]
async fn automatic_runs_send_only_changes_and_a_full_rebuild_runs_daily_or_on_request() {
    let Some(f) = fixture("incremental").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    assert!(
        f.last_run().await.0.get("changes").is_none(),
        "a first build"
    );
    f.complete_active(EMPTY).await;
    let (full_recorded,): (bool,) = query_as(
        "SELECT last_full_at > now() - interval '1 minute' FROM cloud_account_digests \
         WHERE account_id=$1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(full_recorded);

    f.news("The launch moved to next month.").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    let (input, _, _) = f.last_run().await;
    let changes = input["changes"]["sources"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{input}");
    assert_eq!(changes[0]["text"], "The launch moved to next month.");
    f.complete_active(r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[],"removedItemIds":[]}"#).await;

    // The first run after the owner's local morning rebuilds everything.
    f.set("last_full_at=now()-interval '2 days'").await;
    f.news("The venue is booked.").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    assert!(
        f.last_run().await.0.get("changes").is_none(),
        "daily rebuild"
    );
    f.complete_active(EMPTY).await;

    // A full refresh rebuilds even without changes; a plain one does not run.
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    assert!(f.active_run().await.is_none());
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Full)
        .await
        .unwrap();
    assert!(f.active_run().await.is_some());
    assert!(f.last_run().await.0.get("changes").is_none());
}

#[tokio::test]
async fn digest_runs_ask_for_a_fast_model_with_low_thinking_unless_the_owner_chooses() {
    let Some(f) = fixture("model").await else {
        return;
    };
    let chat = format!("chat_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id,idempotency_key,request_message_id,\
         session_id,owner_account_id,requester_account_id,status,prompt,runtime_route_json,\
         created_at,updated_at) VALUES($1,$1,$1,'chat',$2,$2,'completed','hi',$3,$4,$4)",
    )
    .bind(&chat)
    .bind(&f.owner)
    .bind(
        json!({"defaultModel":"openai/gpt-5.6-sol","defaultAuthProvider":"openai",
        "defaultAuthChoice":"api-key","thinking":"xhigh"}),
    )
    .bind("2026-10-01T00:00:00Z")
    .execute(&f.pool)
    .await
    .unwrap();
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    let (_, route, _) = f.last_run().await;
    assert_eq!(route["defaultModel"], "gpt-5.6-luna", "{route}");
    assert_eq!(route["thinking"], "low");
    assert_eq!(route["defaultAuthProvider"], "openai");
    f.settle(60).await;

    let router =
        crate::digest::routes(Arc::new(ServerState::new(f.pool.clone(), EventBus::noop())));
    let settings = router
        .clone()
        .oneshot(authed("GET", "/v1/cloud/digest/settings", &f.token, None))
        .await
        .unwrap();
    let settings = body_json(settings).await;
    assert_eq!(settings["model"], "fast", "{settings}");
    assert_eq!(settings["fastModel"], "gpt-5.6-luna");
    assert_eq!(settings["chatModel"], "openai/gpt-5.6-sol");
    let invalid = router
        .clone()
        .oneshot(authed(
            "PUT",
            "/v1/cloud/digest/settings",
            &f.token,
            Some(json!({"model":"chat","thinking":"extreme"})),
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let saved = router
        .oneshot(authed(
            "PUT",
            "/v1/cloud/digest/settings",
            &f.token,
            Some(json!({"model":"chat"})),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::NO_CONTENT);

    // The chat's route, not the newer digest run's own route.
    f.news("The launch moved to next month.").await;
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    let (_, route, _) = f.last_run().await;
    assert_eq!(route["defaultModel"], "openai/gpt-5.6-sol", "{route}");
    assert_eq!(route["thinking"], "xhigh");
}

#[tokio::test]
async fn an_urgent_message_gets_a_quick_check_and_only_an_urgent_answer_updates_at_once() {
    let Some(f) = fixture("urgent").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    f.settle(60).await;
    f.set("last_full_at=now()").await;
    f.news("Nice work on the draft.").await;
    let (marked,): (bool,) =
        query_as("SELECT urgent_since IS NOT NULL FROM cloud_account_digests WHERE account_id=$1")
            .bind(&f.owner)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!marked, "no date, meeting or question");

    f.news("Can we meet at 3pm tomorrow?").await;
    crate::digest::urgent::start(&f.pool, &f.owner)
        .await
        .unwrap();
    let (input, route, system) = f.last_run().await;
    assert_eq!(input["triage"], true);
    assert_eq!(input["sources"].as_array().unwrap().len(), 1, "{input}");
    assert_eq!(input["sources"][0]["text"], "Can we meet at 3pm tomorrow?");
    assert_eq!(route["thinking"], "off");
    assert_eq!(system, crate::digest::urgent::TRIAGE_SYSTEM_PROMPT);
    assert_eq!(f.runs().await, 2);
    f.complete_active(r#"{"urgent":false}"#).await;
    assert!(f.active_run().await.is_none());
    assert_eq!(f.runs().await, 2, "not urgent: the digest waits");

    // An urgent answer updates the digest at once, past the hourly cap of
    // automatic runs but within the urgent allowance.
    f.news("Actually, can we move it to 2pm today?").await;
    f.automatic_runs(4, "10 minutes").await;
    crate::digest::urgent::start(&f.pool, &f.owner)
        .await
        .unwrap();
    f.complete_active(r#"{"urgent":true}"#).await;
    assert_eq!(f.runs().await, 4, "the quick check and the update");
    let (input, route, _) = f.last_run().await;
    assert!(input["changes"].is_object(), "an incremental update");
    assert_eq!(route["thinking"], "low");

    // A failed check leaves no error on the digest.
    f.settle(60).await;
    f.automatic_runs(1, "10 minutes").await;
    f.news("Are you joining the call tonight?").await;
    crate::digest::urgent::start(&f.pool, &f.owner)
        .await
        .unwrap();
    let run = f.active_run().await.unwrap();
    crate::digest::fail(&f.pool, &run, None, "provider_unavailable")
        .await
        .unwrap();
    let (error, active): (Option<String>, Option<String>) =
        query_as("SELECT error_code, active_run_id FROM cloud_account_digests WHERE account_id=$1")
            .bind(&f.owner)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!((error, active), (None, None));
}

#[tokio::test]
async fn urgent_updates_stop_at_six_runs_an_hour() {
    let Some(f) = fixture("urgent_cap").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    f.settle(60).await;
    f.automatic_runs(6, "10 minutes").await;
    f.news("Can we meet at 3pm tomorrow?").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Urgent)
        .await
        .unwrap();
    assert_eq!(f.runs().await, 1);
}
