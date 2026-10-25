//! The `proactive` field on the agent definition API.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::fixture::*;
use super::offer_db::{last_hint, offer};

#[tokio::test]
async fn proactive_round_trips_and_rejects_other_shapes() {
    let Some(f) = fixture().await else { return };
    let (status, body) = f
        .send(
            "POST",
            "/v1/cloud/agents",
            &f.owner_token,
            Some(json!({"name": "Quiet", "role": "Helper", "systemPrompt": "Help."})),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["agent"]["proactive"],
        json!({"enabled": false}),
        "off by default"
    );
    let quiet = body["agent"]["agentId"].as_str().unwrap().to_string();
    for bad in [
        json!({"enabled": "yes"}),
        json!({"enabled": true, "groups": []}),
        json!({}),
        json!(true),
    ] {
        let (status, body) = f
            .send(
                "POST",
                "/v1/cloud/agents",
                &f.owner_token,
                Some(json!({"name": "Bad", "role": "Helper", "systemPrompt": "Help.", "proactive": bad})),
            )
            .await;
        assert_eq!(status, 400, "{body}");
        let (status, _) = f
            .send(
                "PUT",
                &format!("/v1/cloud/agents/{quiet}"),
                &f.owner_token,
                Some(json!({"proactive": bad})),
            )
            .await;
        assert_eq!(status, 400);
    }
    let uri = format!("/v1/cloud/agents/{quiet}");
    let (status, body) = f
        .send(
            "PUT",
            &uri,
            &f.owner_token,
            Some(json!({"proactive": {"enabled": true}})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agent"]["proactive"], json!({"enabled": true}));
    let (status, body) = f
        .send(
            "PUT",
            &uri,
            &f.owner_token,
            Some(json!({"name": "Quieter"})),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        body["agent"]["proactive"],
        json!({"enabled": true}),
        "missing means unchanged"
    );
    let (status, list) = f
        .send("GET", "/v1/cloud/agents", &f.owner_token, None)
        .await;
    assert_eq!(status, 200);
    let listed = list["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == quiet)
        .unwrap();
    assert_eq!(listed["proactive"], json!({"enabled": true}));
    let (status, _) = f
        .send(
            "PUT",
            &uri,
            &f.owner_token,
            Some(json!({"accessScope": "participant_conversations"})),
        )
        .await;
    assert_eq!(status, 200);
    let (status, shared) = f
        .send(
            "GET",
            &format!("/v1/cloud/agents/shared?ownerAccountIds={}", f.owner),
            &f.member_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{shared}");
    let summary = shared["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == quiet)
        .unwrap();
    assert!(
        summary.get("proactive").is_none(),
        "other accounts never see the setting"
    );
}

async fn status_of(f: &Fixture, table: &str, column: &str, id: &str) -> String {
    let (status,): (String,) = query_as(&format!("SELECT status FROM {table} WHERE {column} = $1"))
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    status
}

async fn definition(f: &Fixture) -> (String, String) {
    query_as("SELECT name, updated_at FROM cloud_agent_definitions WHERE agent_id = $1")
        .bind(&f.agent_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn only_turning_the_setting_off_stops_its_work() {
    let Some(f) = fixture().await else { return };
    let (proposal_id, _) = offer(&f).await;
    // A queued evaluation, copied from the one that made the offer.
    let queued = format!(
        "{}{}",
        crate::proactive::RUN_PREFIX,
        Uuid::new_v4().simple()
    );
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at, execution_backend, execution_agent_id, run_trigger,
             connector_audience)
         SELECT $1, $1, $1, run.session_id, run.owner_account_id, run.requester_account_id,
                'queued', run.prompt, run.system_prompt, run.runtime_route_json, run.created_at,
                run.updated_at, run.execution_backend, run.execution_agent_id, run.run_trigger,
                run.connector_audience
         FROM cloud_agent_fallback_runs run
         JOIN cloud_agent_proactive_proposals p ON p.evaluation_run_id = run.run_id
         WHERE p.proposal_id = $2",
    )
    .bind(&queued)
    .bind(&proposal_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let untouched = |label: &'static str| {
        let f = &f;
        let proposal_id = &proposal_id;
        let queued = &queued;
        async move {
            assert_eq!(
                status_of(
                    f,
                    "cloud_agent_proactive_proposals",
                    "proposal_id",
                    proposal_id
                )
                .await,
                "pending",
                "{label}"
            );
            assert_eq!(
                status_of(f, "cloud_agent_fallback_runs", "run_id", queued).await,
                "queued",
                "{label}"
            );
        }
    };

    // Stored off without the stop, as an agent saved before the stop existed.
    query("UPDATE cloud_agent_definitions SET proactive_json = '{\"enabled\": false}' WHERE agent_id = $1")
        .bind(&f.agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let uri = format!("/v1/cloud/agents/{}", f.agent_id);
    let (status, body) = f
        .send(
            "PUT",
            &uri,
            &f.owner_token,
            Some(json!({"name": "Renamed"})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    untouched("renaming an agent that is off").await;

    let setting = format!("{uri}/proactive");
    let before = definition(&f).await;
    let (status, body) = f
        .send(
            "PUT",
            &setting,
            &f.owner_token,
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": false})));
    untouched("off when already off").await;
    assert_eq!(definition(&f).await, before, "no write at all");

    let (status, body) = f
        .send(
            "PUT",
            &setting,
            &f.owner_token,
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": true})));
    assert_eq!(
        definition(&f).await,
        before,
        "only the setting changes, not the name or updated_at"
    );
    untouched("turning it on").await;

    let (status, body) = f
        .send(
            "PUT",
            &setting,
            &f.owner_token,
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": false})));
    assert_eq!(
        status_of(&f, "cloud_agent_fallback_runs", "run_id", &queued).await,
        "cancelled"
    );
    assert_eq!(
        status_of(
            &f,
            "cloud_agent_proactive_proposals",
            "proposal_id",
            &proposal_id
        )
        .await,
        "expired"
    );
    assert_eq!(last_hint(&f, &proposal_id).await["status"], "expired");
}
