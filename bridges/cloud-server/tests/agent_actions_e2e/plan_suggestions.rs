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

/// (recipient, status) of every `agent_action.updated` sent for an action.
async fn updates(group: &Group, action_id: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT account_id, payload->'agentAction'->>'status' FROM cloud_chat_user_sync_events
         WHERE event_type = 'agent_action.updated' AND payload->'agentAction'->>'actionId' = $1
         ORDER BY stream_seq",
    )
    .bind(action_id)
    .fetch_all(&group.pool)
    .await
    .unwrap()
}

fn dinner(group: &Group, start: &str, location: &str, existing: Option<(&str, &Value)>) -> Value {
    let mut body = json!({"action": "propose", "conversationId": group.conversation,
    "title": "Dinner", "startAt": start, "location": location, "state": "awaitingConfirmation",
    "participants": [
        {"participantId": group.owner.account_id, "displayName": "Olive", "organizer": true},
        {"participantId": group.requester.account_id, "displayName": "Riley"},
    ]});
    if let Some((event_id, revision)) = existing {
        body["existingEventId"] = json!(event_id);
        body["existingRevision"] = revision.clone();
    }
    body
}

async fn suggest_yes(group: &Group, run: &(String, String), event_id: &str) -> String {
    let (status, suggested) = plan_card(
        group,
        run,
        json!({"action": "rsvp", "eventId": event_id,
            "participantId": group.requester.account_id, "rsvp": "yes"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{suggested}");
    suggested["pendingActionId"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_revised_plan_retires_answers_suggested_for_the_old_one() {
    let Some(group) = Group::new("pip-revised", true).await else {
        return;
    };
    let (status, body) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let run = pip_run(&group, &[&group.requester]).await;
    let first = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let (status, card) = plan_card(&group, &run, dinner(&group, &first, "Cafe A", None)).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    let event_id = card["eventId"].as_str().unwrap().to_string();
    let answer = suggest_yes(&group, &run, &event_id).await;
    let organizer_first = group.actions(&group.owner).await[0]["actionId"].clone();

    // PiP moves the plan to another day and place.
    let second = (chrono::Utc::now() + chrono::Duration::days(9)).to_rfc3339();
    let (status, revised) = plan_card(
        &group,
        &run,
        dinner(
            &group,
            &second,
            "Somewhere else",
            Some((&event_id, &card["revision"])),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revised}");

    // The answer suggested for the first plan is gone from the banner, the
    // member's apps hear so, and it can no longer be confirmed.
    assert!(group.actions(&group.requester).await.is_empty());
    assert!(updates(&group, &answer)
        .await
        .contains(&(group.requester.account_id.clone(), "superseded".to_string())));
    let (status, closed) = group.decide(&group.requester, &answer, "approve").await;
    assert_eq!(status, StatusCode::CONFLICT, "{closed}");
    assert_eq!(closed["errorCode"], "agent_action_closed");
    // The organizer is asked again about the revised plan.
    let organizer = group.actions(&group.owner).await;
    assert_eq!(organizer.len(), 1);
    assert_ne!(organizer[0]["actionId"], organizer_first);
    assert_eq!(organizer[0]["subject"]["location"], "Somewhere else");

    // Positive control: an answer suggested for the revised plan applies.
    let fresh = suggest_yes(&group, &run, &event_id).await;
    let (status, applied) = group.decide(&group.requester, &fresh, "approve").await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(rsvp_of(&applied["planCard"], &group.requester), "yes");
    assert_eq!(applied["planCard"]["location"], "Somewhere else");
}

#[tokio::test]
async fn an_answer_or_vote_never_applies_to_a_plan_that_changed_since() {
    let Some(group) = Group::new("pip-changed", true).await else {
        return;
    };
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let run = pip_run(&group, &[&group.requester]).await;
    let start = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let (_, card) = plan_card(&group, &run, dinner(&group, &start, "Cafe A", None)).await;
    let event_id = card["eventId"].as_str().unwrap().to_string();
    let answer = suggest_yes(&group, &run, &event_id).await;
    // The plan changes while the approval is on its way.
    query("UPDATE cloud_plan_cards SET location = 'Somewhere else' WHERE event_id = $1")
        .bind(&event_id)
        .execute(&group.pool)
        .await
        .unwrap();
    let (status, changed) = group.decide(&group.requester, &answer, "approve").await;
    assert_eq!(status, StatusCode::CONFLICT, "{changed}");
    assert_eq!(changed["errorCode"], "plan_changed");
    let (_, current) = call(
        &group.router,
        request(
            "GET",
            &format!("/v1/cloud/plan_cards/{event_id}"),
            Some(&group.requester.token),
            None,
        ),
    )
    .await;
    assert_eq!(rsvp_of(&current, &group.requester), "pending");

    // A vote suggested for an option whose label changed does not apply.
    let (status, poll) = plan_card(
        &group,
        &run,
        json!({"action": "propose", "conversationId": group.conversation, "title": "Brunch",
        "state": "polling", "options": [{"id": "opt_sat", "label": "Saturday"},
                                         {"id": "opt_sun", "label": "Sunday"}],
        "participants": [
            {"participantId": group.owner.account_id, "displayName": "Olive", "organizer": true},
            {"participantId": group.requester.account_id, "displayName": "Riley"},
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{poll}");
    let poll_id = poll["eventId"].as_str().unwrap().to_string();
    let vote_for = |option: &str| {
        json!({"action": "vote", "eventId": poll_id,
            "participantId": group.requester.account_id, "optionId": option})
    };
    let (_, vote) = plan_card(&group, &run, vote_for("opt_sat")).await;
    let vote = vote["pendingActionId"].as_str().unwrap().to_string();
    query(
        "UPDATE cloud_plan_cards SET options = jsonb_set(options, '{0,label}', '\"Saturday evening\"')
         WHERE event_id = $1",
    )
    .bind(&poll_id)
    .execute(&group.pool)
    .await
    .unwrap();
    let (status, changed) = group.decide(&group.requester, &vote, "approve").await;
    assert_eq!(status, StatusCode::CONFLICT, "{changed}");
    assert_eq!(changed["errorCode"], "plan_changed");
    // Positive control: a vote for an unchanged option applies.
    let (_, vote) = plan_card(&group, &run, vote_for("opt_sun")).await;
    let vote = vote["pendingActionId"].as_str().unwrap().to_string();
    let (status, voted) = group.decide(&group.requester, &vote, "approve").await;
    assert_eq!(status, StatusCode::OK, "{voted}");
}

#[tokio::test]
async fn turning_pip_off_tells_approvers_their_suggestions_were_withdrawn() {
    let Some(group) = Group::new("pip-withdrawn", true).await else {
        return;
    };
    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let run = pip_run(&group, &[&group.requester]).await;
    let start = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let (_, card) = plan_card(&group, &run, dinner(&group, &start, "Cafe A", None)).await;
    let event_id = card["eventId"].as_str().unwrap().to_string();
    let answer = suggest_yes(&group, &run, &event_id).await;
    let organizer = group.actions(&group.owner).await[0]["actionId"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, _) = group
        .set_ai_access(&group.owner, json!({"pip_enabled": false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    for (action, approver) in [(&answer, &group.requester), (&organizer, &group.owner)] {
        assert!(
            updates(&group, action)
                .await
                .contains(&(approver.account_id.clone(), "superseded".to_string())),
            "the approver's apps drop the withdrawn suggestion"
        );
        // Skippable for older apps (checked inside `notified`).
        assert_eq!(
            group.notified(action).await,
            vec![approver.account_id.clone()]
        );
    }
    assert!(group.actions(&group.requester).await.is_empty());
}
