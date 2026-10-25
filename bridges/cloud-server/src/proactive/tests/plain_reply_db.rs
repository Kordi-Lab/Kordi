//! A collaborator's message posted as plain text (no group envelope) still
//! gets a reply that names the agent, with its avatar.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::default_agent_db::default_fixture;
use super::offer_db::offer;

const AVATAR: &str = "https://avatars.example.test/minas-kordi.png";

#[tokio::test]
async fn a_plain_text_trigger_gets_a_group_reply_from_the_owners_kordi() {
    let Some(f) = default_fixture(true).await else {
        return;
    };
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_default_agent_profiles (owner_account_id, display_name, avatar_url, \
         avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, \
         avatar_updated_at, created_at, updated_at) \
         VALUES ($1, 'Kordi', $2, 'uploaded', 'thumbs', $1, 'fixture', 1, $3, $3, $3) \
         ON CONFLICT (owner_account_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url",
    )
    .bind(&f.owner)
    .bind(AVATAR)
    .bind(&now)
    .execute(&f.pool)
    .await
    .unwrap();
    // The fixture's collaborator message is plain text, as the HTTP API posts it.
    let (proposal_id, trigger) = offer(&f).await;
    let (content,): (Value,) =
        query_as("SELECT content FROM cloud_chat_messages WHERE message_id::text = $1")
            .bind(&trigger)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let text = content["blocks"][0]["text"].as_str().unwrap();
    assert!(!text.starts_with("kordi-cloud-group:"), "a plain message");

    let (status, body) = f
        .send(
            "POST",
            &format!(
                "/v1/cloud/agents/{}/proactive/proposals/{proposal_id}/decision",
                f.agent_id
            ),
            &f.owner_token,
            Some(json!({"decision": "allow"})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let approved = format!("proactive_run_{proposal_id}");
    f.finish(&approved, "Riya, the deploy fails at the migration step.")
        .await;
    let (reply,): (Value,) = query_as(
        "SELECT m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1",
    )
    .bind(&approved)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let text = reply["blocks"][0]["text"].as_str().unwrap();
    let encoded = text
        .strip_prefix("kordi-cloud-group:")
        .unwrap_or_else(|| panic!("a group envelope, got {text}"));
    let envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    assert_eq!(envelope["groupId"], f.session_id);
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], format!("cloud-agent:{}", f.owner));
    // Storage names a default agent after its profile, as for every reply.
    assert_eq!(message["senderDisplayName"], "Kordi");
    assert_eq!(message["senderOwnerAccountId"], f.owner);
    assert_eq!(message["replyToMessageId"], trigger);
    assert_eq!(
        message["text"],
        "Riya, the deploy fails at the migration step."
    );
    assert_eq!(envelope["actor"]["accountId"], f.owner);
    assert_eq!(envelope["actor"]["agentAvatarUrl"], AVATAR);
    let owner = envelope["participants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|participant| participant["accountId"] == f.owner.as_str())
        .expect("the owner takes part");
    assert_eq!(owner["agentId"], format!("cloud-agent:{}", f.owner));
    assert_eq!(owner["agentAvatarUrl"], AVATAR);
    assert!(envelope["participants"]
        .as_array()
        .unwrap()
        .iter()
        .any(|participant| participant["accountId"] == f.member.as_str()));
}
