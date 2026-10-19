//! How often a digest runs (issue 1869): only changes that matter mark it,
//! opening and polling it do not start runs, background runs wait for quiet
//! chats within a maximum wait and hourly and daily caps, and pressing
//! refresh always works.

use super::audience_tests::conversation;
use super::digest_route_tests::{digest_runs, saved_account};
use super::*;
use crate::chat_sync::models::MessageSnapshot;
use crate::digest::changes::{note_message, MAX_WAIT_MINUTES, QUIET_WINDOW_MINUTES};
use crate::digest::store::{self as digest_store, Trigger};

struct Fixture {
    pool: PgPool,
    owner: String,
    token: String,
    author: String,
    conversation_id: Uuid,
}

/// An owner and a contact in one group with one message from the contact,
/// and a provider account the digest can use.
async fn fixture(label: &str) -> Option<Fixture> {
    let pool = pool().await?;
    let (owner, token) = signed_in_account(&pool, &format!("cadence_{label}_owner")).await;
    let (author, _) = signed_in_account(&pool, &format!("cadence_{label}_author")).await;
    digest_store::initialize_preferences(&pool, &owner, "en-US", "UTC")
        .await
        .unwrap();
    let session = conversation(&pool, "group", &author, &[&owner]).await;
    let (conversation_id,): (Uuid,) =
        query_as("SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id=$1")
            .bind(&session)
            .fetch_one(&pool)
            .await
            .unwrap();
    saved_account(&pool, &owner, "openai", "2026-10-01T00:00:00Z", None).await;
    let fixture = Fixture {
        pool,
        owner,
        token,
        author,
        conversation_id,
    };
    fixture
        .message(&fixture.author, "Please review the draft by Friday.")
        .await;
    Some(fixture)
}

impl Fixture {
    async fn message(&self, sender: &str, text: &str) -> MessageSnapshot {
        let (sequence,): (i64,) = query_as(
            "SELECT COALESCE(MAX(conversation_sequence),0)+1 FROM cloud_chat_messages \
             WHERE conversation_id=$1",
        )
        .bind(self.conversation_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let message = MessageSnapshot {
            id: Uuid::new_v4(),
            client_message_id: Uuid::new_v4(),
            conversation_id: self.conversation_id,
            conversation_sequence: sequence,
            sender_account_id: sender.into(),
            kind: "text".into(),
            content: json!({"blocks":[{"type":"text","text":text}]}),
            reply_to_message_id: None,
            attachment_ids: vec![],
            version: 1,
            generation_status: None,
            provider_response_id: None,
            created_at: Utc::now(),
            edited_at: None,
            deleted_at: None,
            reactions: vec![],
            attachment_reactions: vec![],
        };
        query(
            "INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,\
             sender_account_id,client_message_id,request_fingerprint,content) \
             VALUES($1,$2,$3,$4,$5,'test',$6)",
        )
        .bind(message.id)
        .bind(self.conversation_id)
        .bind(sequence)
        .bind(sender)
        .bind(message.client_message_id)
        .bind(&message.content)
        .execute(&self.pool)
        .await
        .unwrap();
        message
    }

    /// Whether the owner's digest is marked, and whether the owner is active.
    async fn marks(&self) -> (bool, bool) {
        query_as(
            "SELECT dirty_since IS NOT NULL, owner_active_at IS NOT NULL \
             FROM cloud_account_digests WHERE account_id=$1",
        )
        .bind(&self.owner)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn runs(&self) -> usize {
        digest_runs(&self.pool, &self.owner).await.len()
    }

    /// Completes the active run with an empty digest saved `age_minutes` ago,
    /// as a runner would, and marks a new change.
    async fn settle(&self, age_minutes: i32) {
        query(
            "UPDATE cloud_agent_fallback_runs SET status='completed' \
             WHERE owner_account_id=$1 AND run_id LIKE 'digest\\_%'",
        )
        .bind(&self.owner)
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "UPDATE cloud_account_digests SET \
             snapshot_json='{\"claims\":[],\"commitments\":[],\"suggestions\":[],\"calendarCandidates\":[]}', \
             snapshot_input_json=input_json, active_run_id=NULL, error_code=NULL, \
             dirty_since=NULL, last_change_at=NULL, \
             updated_at=now()-make_interval(mins => $2) WHERE account_id=$1",
        )
        .bind(&self.owner)
        .bind(age_minutes)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn open(&self) -> Value {
        let router = crate::digest::routes(Arc::new(ServerState::new(
            self.pool.clone(),
            EventBus::noop(),
        )));
        let response = router
            .oneshot(authed(
                "GET",
                "/v1/cloud/digest?locale=en-US&timezone=UTC",
                &self.token,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        body_json(response).await
    }

    /// Waits for the refresh that opening the digest may have started.
    async fn runs_after_open(&self, expected: usize) -> usize {
        for _ in 0..50 {
            if self.runs().await >= expected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        // Long enough for a refresh that should not have started to show.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        self.runs().await
    }

    async fn automatic_runs(&self, count: i32, age: &str) {
        query(
            "INSERT INTO cloud_digest_runs(run_id,account_id,run_trigger,created_at) \
             SELECT 'past_'||gen_random_uuid(), $1, 'automatic', now()-$3::interval \
             FROM generate_series(1,$2)",
        )
        .bind(&self.owner)
        .bind(count)
        .bind(age)
        .execute(&self.pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn only_messages_from_other_people_mark_the_digest() {
    let Some(f) = fixture("relevance").await else {
        return;
    };
    let own = f.message(&f.owner, "I'll send the report by Friday.").await;
    note_message(&f.pool, "message.created", &own)
        .await
        .unwrap();
    assert_eq!(f.marks().await, (false, true), "the owner's own message");

    // An agent reply is sent under its owner's account.
    let mut reply = f.message(&f.owner, "Here is a summary of the draft.").await;
    reply.generation_status = Some("generating".into());
    note_message(&f.pool, "message.created", &reply)
        .await
        .unwrap();
    reply.generation_status = Some("complete".into());
    note_message(&f.pool, "message.updated", &reply)
        .await
        .unwrap();
    assert!(!f.marks().await.0, "the owner's agent reply");

    // Edits and deletions of a message the digest already read.
    let digested = f.message(&f.author, "Moving the review to Monday.").await;
    query("UPDATE cloud_account_digests SET snapshot_input_json=$2 WHERE account_id=$1")
        .bind(&f.owner)
        .bind(json!({"sources":[{"id": digested.id.to_string()}]}))
        .execute(&f.pool)
        .await
        .unwrap();
    note_message(&f.pool, "message.updated", &digested)
        .await
        .unwrap();
    note_message(&f.pool, "message.deleted", &digested)
        .await
        .unwrap();
    let acknowledgement = f.message(&f.author, "ok thanks").await;
    note_message(&f.pool, "message.created", &acknowledgement)
        .await
        .unwrap();
    assert!(!f.marks().await.0, "edits, deletions and acknowledgements");

    let news = f.message(&f.author, "Can you join the call at 3pm?").await;
    note_message(&f.pool, "message.created", &news)
        .await
        .unwrap();
    assert!(f.marks().await.0, "a new message from someone else");
}

#[tokio::test]
async fn automatic_runs_skip_changes_that_do_not_matter() {
    let Some(f) = fixture("own_changes").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    f.settle(60).await;
    f.message(&f.owner, "I'll send the report by Friday.").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    assert_eq!(f.runs().await, 1, "only the owner's own message changed");
    f.message(&f.author, "Can you join the call at 3pm?").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    assert_eq!(f.runs().await, 2, "a new message from someone else");
}

#[tokio::test]
async fn polling_the_open_digest_starts_at_most_one_run_for_a_stale_snapshot() {
    let Some(f) = fixture("open").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    f.settle(1).await;
    let news = f.message(&f.author, "Can you join the call at 3pm?").await;
    note_message(&f.pool, "message.created", &news)
        .await
        .unwrap();
    for _ in 0..3 {
        let digest = f.open().await;
        assert!(digest["snapshot"].is_object(), "{digest}");
        assert!(digest["updatedAt"].is_string(), "{digest}");
    }
    assert_eq!(f.runs_after_open(2).await, 1, "a fresh snapshot is shown");

    query("UPDATE cloud_account_digests SET updated_at=now()-interval '20 minutes' WHERE account_id=$1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    for _ in 0..3 {
        f.open().await;
    }
    assert_eq!(
        f.runs_after_open(2).await,
        2,
        "one run for a stale snapshot"
    );

    // Polls after that run finished do not start another one.
    f.settle(20).await;
    let news = f.message(&f.author, "And bring the slides.").await;
    note_message(&f.pool, "message.created", &news)
        .await
        .unwrap();
    for _ in 0..3 {
        f.open().await;
    }
    assert_eq!(f.runs_after_open(3).await, 2, "at most one run per open");
}

#[tokio::test]
async fn background_runs_wait_for_quiet_chats_up_to_the_maximum_wait() {
    let Some(f) = fixture("quiet").await else {
        return;
    };
    let due = |dirty: i32, change: i32, owner: Option<i32>| {
        let pool = f.pool.clone();
        let account = f.owner.clone();
        async move {
            query(
                "UPDATE cloud_account_digests SET snapshot_json='{}', checked_at=now(), \
                 dirty_since=now()-make_interval(mins => $2), \
                 last_change_at=now()-make_interval(mins => $3), \
                 owner_active_at=now()-make_interval(mins => $4) WHERE account_id=$1",
            )
            .bind(&account)
            .bind(dirty)
            .bind(change)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
            let (due,): (bool,) = query_as(&format!(
                "SELECT EXISTS(SELECT 1 FROM cloud_account_digests WHERE account_id=$4 AND {})",
                crate::digest::worker::DUE
            ))
            .bind(QUIET_WINDOW_MINUTES as i32)
            .bind(MAX_WAIT_MINUTES as i32)
            .bind(30)
            .bind(&account)
            .fetch_one(&pool)
            .await
            .unwrap();
            due
        }
    };
    assert!(!due(2, 2, None).await, "contacts still chatting");
    assert!(due(6, 6, None).await, "quiet for five minutes");
    assert!(!due(6, 6, Some(1)).await, "the owner is still chatting");
    assert!(
        due(31, 1, Some(1)).await,
        "thirty minutes after the first change"
    );
}

#[tokio::test]
async fn one_run_in_flight_and_caps_bind_only_automatic_runs() {
    let Some(f) = fixture("caps").await else {
        return;
    };
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    assert_eq!(f.runs().await, 1, "a run is already in flight");

    f.settle(60).await;
    f.message(&f.author, "Can you join the call at 3pm?").await;
    // One automatic run above, three more make four in the last hour.
    f.automatic_runs(3, "10 minutes").await;
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    assert_eq!(f.runs().await, 1, "hourly cap");
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    assert_eq!(f.runs().await, 2, "pressing refresh is not capped");

    f.settle(60).await;
    let news = f.message(&f.author, "And bring the slides.").await;
    note_message(&f.pool, "message.created", &news)
        .await
        .unwrap();
    query("DELETE FROM cloud_digest_runs WHERE account_id=$1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    f.automatic_runs(30, "3 hours").await;
    query("UPDATE cloud_account_digests SET retry_after=now() WHERE account_id=$1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    digest_store::refresh_as(&f.pool, &f.owner, Trigger::Automatic)
        .await
        .unwrap();
    assert_eq!(f.runs().await, 2, "daily cap");
    let (deferred,): (bool,) = query_as(
        "SELECT retry_after > now() + interval '1 minute' AND dirty_since IS NOT NULL \
         FROM cloud_account_digests WHERE account_id=$1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(
        deferred,
        "a capped digest stays marked and waits before the worker looks again"
    );
}

#[tokio::test]
async fn a_source_change_retries_after_a_wait_instead_of_at_once() {
    let Some(f) = fixture("sources_changed").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    let (run,): (String,) =
        query_as("SELECT active_run_id FROM cloud_account_digests WHERE account_id=$1")
            .bind(&f.owner)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    crate::digest::fail(&f.pool, &run, None, "sources_changed")
        .await
        .unwrap();
    let (waits, marked): (bool, bool) = query_as(
        "SELECT retry_after > now() + interval '1 minute', dirty_since IS NOT NULL \
         FROM cloud_account_digests WHERE account_id=$1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(waits && marked, "waits={waits} marked={marked}");
}

#[tokio::test]
async fn an_edited_source_hides_only_its_items_without_a_rerun() {
    let Some(f) = fixture("edited").await else {
        return;
    };
    digest_store::refresh(&f.pool, &f.owner).await.unwrap();
    f.settle(1).await;
    let (source,): (String,) = query_as(
        "SELECT input_json->'sources'->0->>'id' FROM cloud_account_digests WHERE account_id=$1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let item = |id: &str, sources: Vec<String>| json!({"id":id,"title":"Review","text":"Review the draft.","sourceIds":sources,"kind":"open"});
    query("UPDATE cloud_account_digests SET snapshot_json=$2 WHERE account_id=$1")
        .bind(&f.owner)
        .bind(
            json!({"claims":[item("edited", vec![source.clone()]), item("unsupported", vec![])],
            "commitments":[],"suggestions":[],"calendarCandidates":[]}),
        )
        .execute(&f.pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_messages SET version=version+1 WHERE message_id=$1::uuid")
        .bind(&source)
        .execute(&f.pool)
        .await
        .unwrap();
    let digest = f.open().await;
    assert_eq!(digest["status"], "ready", "{digest}");
    let claims = digest["snapshot"]["claims"].as_array().unwrap();
    assert_eq!(claims.len(), 1, "{digest}");
    assert_eq!(claims[0]["id"], "unsupported");
    assert_eq!(f.runs_after_open(2).await, 1);
}
