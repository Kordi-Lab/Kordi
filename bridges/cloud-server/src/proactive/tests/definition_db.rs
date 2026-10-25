//! The `proactive` field on the agent definition API.

use serde_json::json;

use super::fixture::*;

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
    assert_eq!(summary["proactive"], json!({"enabled": true}));
}
