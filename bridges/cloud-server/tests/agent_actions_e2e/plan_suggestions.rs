use super::*;

/// A leased PiP sweep run whose new messages came from `writers`.
async fn pip_run(group: &Group, writers: &[&TestAccount]) -> (String, String) {
    let pip = group.pip.as_ref().unwrap();
    let run_id = format!("pip_{}", Uuid::new_v4().simple());
    let messages: Vec<Value> = writers
        .iter()
        .enumerate()
        .map(|(index, writer)| {
            json!({"id": format!("m{index}"), "senderId": writer.account_id, "isNew": true})
        })
        .collect();
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,
             session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at)
         VALUES($1,$1,$1,$2,$3,$3,'queued',$4,$5,$5)",
    )
    .bind(&run_id)
    .bind(&group.session)
    .bind(&pip.account_id)
    .bind(json!({"messages": messages}).to_string())
    .bind(now)
    .execute(&group.pool)
    .await
    .unwrap();
    let token = group.lease_for_runner(&run_id).await;
    (run_id, token)
}

async fn plan_card(group: &Group, run: &(String, String), body: Value) -> (StatusCode, Value) {
    group
        .runner_post(
            &run.0,
            &run.1,
            "plan-card",
            json!({"runnerId": RUNNER_ID, "request": body}),
        )
        .await
}

fn rsvp_of(card: &Value, account: &TestAccount) -> String {
    card["participants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|participant| participant["participantId"] == account.account_id)
        .unwrap()["rsvp"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn pip_suggestions_wait_for_their_approvers() {
    let Some(group) = Group::new("pip-suggest", true).await else {
        return;
    };
    let (status, body) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let run = pip_run(&group, &[&group.requester]).await;
    let start = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let (status, card) = plan_card(
        &group,
        &run,
        json!({"action": "propose", "conversationId": group.conversation,
        "title": "Dinner", "startAt": start, "state": "awaitingConfirmation",
        "participants": [
            {"participantId": group.owner.account_id, "displayName": "Olive", "organizer": true},
            {"participantId": group.requester.account_id, "displayName": "Riley"},
            {"participantId": group.member.account_id, "displayName": "Morgan"},
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    let event_id = card["eventId"].as_str().unwrap().to_string();
    assert_eq!(rsvp_of(&card, &group.owner), "pending");

    // PiP's answer for a member who wrote is only a suggestion for them.
    let (status, suggested) = plan_card(
        &group,
        &run,
        json!({"action": "rsvp", "eventId": event_id,
            "participantId": group.requester.account_id, "rsvp": "yes"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{suggested}");
    assert_eq!(suggested["status"], "suggested");
    assert_eq!(suggested["awaiting"], "member");
    assert_eq!(suggested["card"]["revision"], card["revision"]);
    assert_eq!(rsvp_of(&suggested["card"], &group.requester), "pending");
    let rsvp_action = suggested["pendingActionId"].as_str().unwrap().to_string();

    // Never for a member who did not write in the new messages.
    let (status, _) = plan_card(
        &group,
        &run,
        json!({"action": "rsvp", "eventId": event_id,
            "participantId": group.member.account_id, "rsvp": "no"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A decision waits for the organizer or an admin.
    let (status, decision) = plan_card(
        &group,
        &run,
        json!({"action": "confirm", "eventId": event_id, "revision": card["revision"],
            "confirmedBy": group.owner.account_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decision}");
    assert_eq!(decision["status"], "suggested");
    assert_eq!(decision["awaiting"], "organizer_or_admin");
    assert_eq!(decision["card"]["state"], "awaiting_confirmation");
    let confirm_action = decision["pendingActionId"].as_str().unwrap().to_string();

    let requester_kinds: Vec<Value> = group
        .actions(&group.requester)
        .await
        .iter()
        .map(|action| action["kind"].clone())
        .collect();
    assert_eq!(requester_kinds, vec![json!("plan_rsvp")]);
    assert!(group.actions(&group.member).await.is_empty());
    let mut owner_kinds: Vec<String> = group
        .actions(&group.owner)
        .await
        .iter()
        .map(|action| action["kind"].as_str().unwrap().to_string())
        .collect();
    owner_kinds.sort();
    // The organizer's own yes, and the plan decision.
    assert_eq!(owner_kinds, vec!["plan_confirm", "plan_rsvp"]);
    let pip_name = group.actions(&group.requester).await[0]["proposedBy"].clone();
    assert_eq!(pip_name["kind"], "pip");
    assert_eq!(
        group.notified(&rsvp_action).await,
        vec![group.requester.account_id.clone()]
    );
    assert_eq!(
        group.notified(&confirm_action).await,
        vec![group.owner.account_id.clone()]
    );

    // The member confirms their answer; it applies as them.
    assert_eq!(
        group.decide(&group.member, &rsvp_action, "approve").await.0,
        StatusCode::NOT_FOUND
    );
    let (status, applied) = group
        .decide(&group.requester, &rsvp_action, "approve")
        .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["action"]["status"], "applied");
    assert_eq!(rsvp_of(&applied["planCard"], &group.requester), "yes");

    // The confirm was suggested at the older revision: the plan changed.
    let (status, stale) = group.decide(&group.owner, &confirm_action, "approve").await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["errorCode"], "plan_changed");
    let (_, refreshed) = call(
        &group.router,
        request(
            "GET",
            &format!("/v1/cloud/plan_cards/{event_id}"),
            Some(&group.owner.token),
            None,
        ),
    )
    .await;
    assert_eq!(refreshed["state"], "awaiting_confirmation");

    // Suggested again at the current revision, the organizer confirms it.
    let (_, decision) = plan_card(
        &group,
        &run,
        json!({"action": "confirm", "eventId": event_id, "revision": refreshed["revision"],
            "confirmedBy": group.owner.account_id}),
    )
    .await;
    let confirm_action = decision["pendingActionId"].as_str().unwrap().to_string();
    let (status, confirmed) = group.decide(&group.owner, &confirm_action, "approve").await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["planCard"]["state"], "confirmed");

    // Turning PiP off retires its waiting suggestions.
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(group
        .actions(&group.owner)
        .await
        .iter()
        .all(|action| !action["kind"].as_str().unwrap().starts_with("plan_")));
}
