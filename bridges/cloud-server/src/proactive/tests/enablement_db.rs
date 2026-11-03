//! The acknowledged setting change, rather than a later sweep, starts watching.
use super::default_agent_db::default_fixture;
use super::fixture::*;
use crate::proactive::sweep::{evaluate, Outcome};
use serde_json::json;

async fn set_enabled(f: &Fixture, enabled: bool) {
    let (status, _) = f
        .send(
            "PUT",
            &format!("/v1/cloud/agents/{}/cooperative", f.agent_id),
            &f.owner_token,
            Some(json!({"enabled": enabled})),
        )
        .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn first_request_after_enable_survives_worker_startup() {
    for default in [false, true] {
        for prune_while_disabled in [false, true] {
            let f = if default {
                default_fixture(false).await
            } else {
                fixture().await
            };
            let Some(f) = f else { return };
            set_enabled(&f, false).await;
            if prune_while_disabled {
                f.seed().await;
                // Older workers pruned disabled cursors; support that state too.
                sqlx_core::query::query(
                    "DELETE FROM cloud_agent_proactive_state WHERE agent_id=$1",
                )
                .bind(&f.agent_id)
                .execute(&f.pool)
                .await
                .unwrap();
            }
            say(
                &f.pool,
                &f.member,
                f.group,
                "Disabled history: help with the build",
                5,
            )
            .await;
            assert!(
                f.candidate(&config()).await.is_none(),
                "disabled stays silent"
            );
            set_enabled(&f, true).await;
            let boundary = f.latest_sequence().await;
            // No watcher tick occurs between acknowledgement and this write.
            say(
                &f.pool,
                &f.member,
                f.group,
                "Fresh request: I need help debugging this build",
                5,
            )
            .await;
            // Idempotent writes must not move the boundary over the new request.
            set_enabled(&f, true).await;
            f.seed().await;
            let candidate = f
                .candidate(&config())
                .await
                .expect("first enabled request remains eligible");
            assert_eq!(
                candidate.seen_sequence, boundary,
                "disabled history stays excluded"
            );
            assert_eq!(
                evaluate(&f.pool, &candidate).await.unwrap(),
                Outcome::Queued
            );
            assert!(f.candidate(&config()).await.is_none(), "admitted once");
        }
    }
}

#[tokio::test]
async fn creation_and_definition_update_capture_the_same_boundary() {
    let Some(f) = fixture().await else { return };
    let boundary = f.latest_sequence().await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "I need help with the new build",
        5,
    )
    .await;
    f.seed().await;
    let candidate = f
        .candidate(&config())
        .await
        .expect("creation already enabled watching");
    assert_eq!(candidate.seen_sequence, boundary);
    set_enabled(&f, false).await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "Disabled history: help with tests",
        5,
    )
    .await;
    let boundary = f.latest_sequence().await;
    let (status, _) = f
        .send(
            "PATCH",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            Some(json!({"cooperative": {"enabled": true}})),
        )
        .await;
    assert_eq!(status, 200);
    say(
        &f.pool,
        &f.member,
        f.group,
        "Fresh request: help with the failing tests",
        5,
    )
    .await;
    f.seed().await;
    assert_eq!(
        f.candidate(&config())
            .await
            .expect("update enabled watching")
            .seen_sequence,
        boundary
    );
}

#[tokio::test]
async fn disabling_does_not_clear_cooldown_or_replay_disabled_history() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    sqlx_core::query::query("UPDATE cloud_agent_proactive_state SET cooldown_until=now()+interval '20 minutes' WHERE agent_id=$1")
        .bind(&f.agent_id).execute(&f.pool).await.unwrap();
    set_enabled(&f, false).await;
    f.seed().await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "Disabled history: please help",
        5,
    )
    .await;
    set_enabled(&f, true).await;
    assert_eq!(f.state().await.0, f.latest_sequence().await);
    assert!(f.state().await.2, "toggle keeps the original cooldown");
    say(
        &f.pool,
        &f.member,
        f.group,
        "Fresh request: please help debug",
        5,
    )
    .await;
    assert!(
        f.candidate(&config()).await.is_none(),
        "cooldown still suppresses evaluation"
    );
}
