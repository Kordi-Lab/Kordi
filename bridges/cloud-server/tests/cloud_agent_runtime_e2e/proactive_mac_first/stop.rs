//! A Mac run that was stopped posts nothing, and an approved run the Mac
//! completes notifies the group as a cloud reply does.

use super::*;

/// A push service with a key made for this test only. No push is sent: the
/// test accounts register no device tokens.
fn test_push() -> kordi_cloud_server::notifications::PushNotificationService {
    use p256::pkcs8::{EncodePrivateKey, LineEnding};
    let key = p256::SecretKey::from_slice(&[7_u8; 32]).unwrap();
    let pem = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let env = [
        ("KORDI_APNS_ENVIRONMENT", "development".to_string()),
        ("KORDI_APNS_KEY_ID", "TESTKEY001".to_string()),
        ("KORDI_APNS_TEAM_ID", "TESTTEAM01".to_string()),
        (
            "KORDI_APNS_PRIVATE_KEY_BASE64",
            base64::engine::general_purpose::STANDARD.encode(pem.as_bytes()),
        ),
        ("KORDI_APNS_BUNDLE_ID", "ai.kordi.test".to_string()),
    ];
    for (name, value) in &env {
        std::env::set_var(name, value);
    }
    let service = kordi_cloud_server::notifications::PushNotificationService::from_env();
    for (name, _) in &env {
        std::env::remove_var(name);
    }
    service.unwrap().expect("a configured push service")
}

/// The approved run, claimed and admitted by the Mac: `(run_id, claim_id,
/// proposal_id)`.
async fn admitted_run(fx: &Fixture) -> (String, uuid::Uuid, String) {
    let (proposal_id, _) = fx.offer().await;
    let run_id = fx.allow(&proposal_id).await;
    let claim_id = uuid::Uuid::new_v4();
    fx.mac_takes(&run_id, claim_id).await;
    let (status, admitted) = fx
        .post(
            &format!("/v1/cloud/agent-runs/desktop/{run_id}/admit"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{admitted}");
    assert_eq!(admitted["admitted"], true);
    (run_id, claim_id, proposal_id)
}

/// The texts of the agent replies in the group.
async fn group_replies(fx: &Fixture) -> Vec<String> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages WHERE conversation_id = $1 ORDER BY conversation_sequence",
    )
    .bind(fx.group)
    .fetch_all(&fx.pool)
    .await
    .unwrap();
    rows.into_iter()
        .filter_map(|(content,)| content["blocks"][0]["text"].as_str().map(str::to_string))
        .filter(|text| text.starts_with("kordi-cloud-group:"))
        .map(|text| decode_test_cloud_group_envelope(&text))
        .filter(|envelope| envelope["message"]["senderKind"] == "agent")
        .map(|envelope| {
            envelope["message"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn an_approved_run_stopped_on_the_mac_posts_only_the_stop_reply() {
    let Some(fx) = fixture("proactive-mac-stop", true).await else {
        return;
    };
    let (run_id, claim_id, proposal_id) = admitted_run(&fx).await;
    let (status, stopped) = fx
        .post(&format!("/v1/cloud/agent-runs/{run_id}/stop"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["run"]["cancelRequested"], true);
    // The Mac hears of the stop from its renewal.
    let (status, renewed) = fx
        .post(
            &format!("/v1/cloud/agent-runs/desktop/{run_id}/renew"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renewed}");
    assert_eq!(renewed["cancelRequested"], true);

    let reply = "Riya, the deploy fails at the migration step.";
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, reply).await,
        StatusCode::CONFLICT,
        "a stopped run posts nothing"
    );
    assert_eq!(fx.run_state(&run_id).await.0, "cancelled");
    let replies = group_replies(&fx).await;
    assert!(!replies.iter().any(|text| text == reply), "{replies:?}");
    assert_eq!(
        replies,
        vec![kordi_cloud_server::cloud_agent_runtime::runs::stop::STOPPED_TEXT.to_string()],
        "the group gets the stop reply, as for any stopped run"
    );
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, reply).await,
        StatusCode::CONFLICT
    );
    kordi_cloud_server::proactive::sync_runs(&fx.pool, Some(&run_id))
        .await
        .unwrap();
    assert_eq!(fx.proposal_status(&proposal_id).await, "failed");
    fx.finish().await;
}

#[tokio::test]
async fn a_stopped_evaluation_makes_no_offer() {
    let Some(fx) = fixture("proactive-mac-stop-eval", true).await else {
        return;
    };
    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_takes(&run_id, claim_id).await;
    let (status, _) = fx
        .post(&format!("/v1/cloud/agent-runs/{run_id}/stop"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let trigger = trigger_of(&claimed["proactive"]["prompt"]);
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, &offer_reply(&trigger))
            .await,
        StatusCode::CONFLICT
    );
    assert_eq!(fx.run_state(&run_id).await.0, "cancelled");
    let (proposals,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(proposals, 0);
    fx.finish().await;
}

#[tokio::test]
async fn an_approved_run_the_mac_completes_notifies_the_group() {
    let Some(fx) = fixture_with("proactive-mac-notify", true, Some(test_push())).await else {
        return;
    };
    let (run_id, claim_id, _) = admitted_run(&fx).await;
    let reply = "Riya, the deploy fails at the migration step.";
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, reply).await,
        StatusCode::OK
    );
    let (message_id,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    let message_id = uuid::Uuid::parse_str(&message_id.expect("the reply")).unwrap();
    let mut recipients: Vec<(String,)> = query_as(
        "SELECT recipient_account_id FROM cloud_message_notification_events WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_all(&fx.pool)
    .await
    .unwrap();
    recipients.sort();
    let mut expected = vec![
        (fx.member.account_id.clone(),),
        (fx.owner.account_id.clone(),),
    ];
    expected.sort();
    assert_eq!(
        recipients, expected,
        "every member hears of the agent's reply, as for a cloud reply"
    );
    fx.finish().await;
}
