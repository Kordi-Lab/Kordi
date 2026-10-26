//! The Proactive setting through its route and the agent definition, and the
//! `cooperative` alias of the group setting.

use serde_json::json;
use sqlx_core::query_as::query_as;

use super::fixture::*;

fn personal_uri(agent_id: &str) -> String {
    format!("/v1/cloud/agents/{agent_id}/personal-agent")
}

#[tokio::test]
async fn the_setting_round_trips_for_definitions_and_the_default_agent() {
    let Some(f) = fixture().await else { return };
    let (status, body) = f
        .send("GET", &personal_uri(&f.agent_id), &f.owner_token, None)
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"proactive": false})));
    let (status, body) = f.set_proactive(&f.agent_id, true).await;
    assert_eq!((status.as_u16(), body), (200, json!({"proactive": true})));
    let (_, list) = f
        .send("GET", "/v1/cloud/agents", &f.owner_token, None)
        .await;
    let scout = list["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agentId"] == f.agent_id.as_str())
        .unwrap()
        .clone();
    assert_eq!(scout["personalAgent"], json!({"proactive": true}));
    assert_eq!(scout["cooperative"], scout["proactive"]);
    // The owner's other devices hear of the change.
    let (synced,): (serde_json::Value,) = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'agent.definition.upserted' \
         ORDER BY stream_seq DESC LIMIT 1",
    )
    .bind(&f.owner)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(synced["agent"]["personalAgent"], json!({"proactive": true}));

    let default_agent = format!("cloud-agent:{}", f.owner);
    let (status, body) = f.set_proactive(&default_agent, true).await;
    assert_eq!((status.as_u16(), body), (200, json!({"proactive": true})));
    let (_, body) = f
        .send("GET", &personal_uri(&default_agent), &f.owner_token, None)
        .await;
    assert_eq!(body, json!({"proactive": true}));
    let (status, body) = f.set_proactive(&default_agent, false).await;
    assert_eq!((status.as_u16(), body), (200, json!({"proactive": false})));
}

#[tokio::test]
async fn only_the_owner_can_change_it_and_bodies_are_strict() {
    let Some(f) = fixture().await else { return };
    let uri = personal_uri(&f.agent_id);
    let body = Some(json!({"proactive": true}));
    let (status, body) = f.send("PUT", &uri, &f.other_token, body).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = f
        .send(
            "PUT",
            &uri,
            &f.owner_token,
            Some(json!({"proactive": true, "quiet": 1})),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "invalid_personal_agent");
    let (status, _) = f
        .send(
            "GET",
            &personal_uri("cloud_agent_missing"),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 404);
    let (status, _) = f
        .send(
            "DELETE",
            &format!("/v1/cloud/agents/{}", f.agent_id),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = f.send("GET", &uri, &f.owner_token, None).await;
    assert_eq!(status, 404, "an archived definition");
}

#[tokio::test]
async fn cooperative_is_an_alias_of_proactive() {
    let Some(f) = fixture().await else { return };
    let create = |extra: serde_json::Value| {
        let mut body = json!({"name": "Helper", "role": "Helper", "systemPrompt": "Help."});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let (status, body) = f
        .send(
            "POST",
            "/v1/cloud/agents",
            &f.owner_token,
            Some(create(json!({
                "cooperative": {"enabled": true},
                "personalAgent": {"proactive": true},
            }))),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["agent"]["proactive"], json!({"enabled": true}));
    assert_eq!(body["agent"]["cooperative"], json!({"enabled": true}));
    assert_eq!(body["agent"]["personalAgent"], json!({"proactive": true}));
    let created = body["agent"]["agentId"].as_str().unwrap().to_string();
    let (cursor_set,): (bool,) =
        query_as("SELECT EXISTS(SELECT 1 FROM cloud_personal_agent_state WHERE agent_id = $1)")
            .bind(&created)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(cursor_set, "turning it on at creation starts the cursor");

    let (status, body) = f
        .send(
            "POST",
            "/v1/cloud/agents",
            &f.owner_token,
            Some(create(json!({
                "proactive": {"enabled": true},
                "cooperative": {"enabled": false},
            }))),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "invalid_proactive");

    let update = format!("/v1/cloud/agents/{created}");
    let (status, body) = f
        .send(
            "PUT",
            &update,
            &f.owner_token,
            Some(json!({"cooperative": {"enabled": false}, "personalAgent": {"proactive": false}})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agent"]["proactive"], json!({"enabled": false}));
    assert_eq!(body["agent"]["personalAgent"], json!({"proactive": false}));
    let (status, body) = f
        .send(
            "PUT",
            &update,
            &f.owner_token,
            Some(json!({"personalAgent": {"on": true}})),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "invalid_personal_agent");

    let alias = format!("/v1/cloud/agents/{created}/cooperative");
    let (status, body) = f
        .send(
            "PUT",
            &alias,
            &f.owner_token,
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!((status.as_u16(), body), (200, json!({"enabled": true})));
    let (_, body) = f
        .send(
            "GET",
            &format!("/v1/cloud/agents/{created}/proactive"),
            &f.owner_token,
            None,
        )
        .await;
    assert_eq!(
        body,
        json!({"enabled": true}),
        "one setting under two names"
    );
}
