use super::*;

const START: &str = "2026-10-02T00:00:00Z";
const END: &str = "2026-10-03T00:00:00Z";

async fn save_event(group: &Group) {
    query(
        "INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'saved',$2)
         ON CONFLICT DO NOTHING",
    )
    .bind(&group.owner.account_id)
    .bind(json!({"id": "saved", "title": "Saved appointment",
        "startAt": "2026-10-02T12:00:00Z", "sourceIds": []}))
    .execute(&group.pool)
    .await
    .unwrap();
}

async fn read_shared(group: &Group, request_id: &str, window: (&str, &str)) -> (StatusCode, Value) {
    call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/calendar/read",
            Some(&group.owner.token),
            Some(
                json!({"sessionId": group.session, "requestMessageId": request_id,
                "shareInConversation": true, "startAt": window.0, "endAt": window.1}),
            ),
        ),
    )
    .await
}

async fn calendar_actions(group: &Group) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_pending_actions
         WHERE conversation_id = $1 AND kind = 'calendar_disclosure'",
    )
    .bind(group.conversation)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn sharing_a_calendar_waits_for_the_owner_and_a_grant_covers_the_window() {
    let Some(group) = Group::new("calendar-grant", false).await else {
        return;
    };
    save_event(&group).await;
    let first = format!("cal-1-{}", group.tag);
    group
        .ask(&group.owner, &first, "share my calendar for tomorrow here")
        .await;

    let (status, waiting) = read_shared(&group, &first, (START, END)).await;
    assert_eq!(status, StatusCode::OK, "{waiting}");
    assert_eq!(waiting["status"], "approval_required");
    assert!(waiting.get("events").is_none(), "no data before approval");
    assert_eq!(
        waiting["message"],
        "Waiting for Olive Owner to approve sharing their calendar in this chat. \
         Do not share or guess calendar details."
    );
    assert!(waiting["timeoutMessage"]
        .as_str()
        .unwrap()
        .starts_with("Olive Owner has not approved"));
    let action_id = waiting["pendingActionId"].as_str().unwrap().to_string();
    // Paging the same window reuses the waiting request.
    let (_, again) = read_shared(&group, &first, (START, END)).await;
    assert_eq!(again["pendingActionId"], waiting["pendingActionId"]);
    assert_eq!(calendar_actions(&group).await, 1);

    // Only the owner sees and decides it.
    let listed = group.actions(&group.owner).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["kind"], "calendar_disclosure");
    assert_eq!(listed[0]["proposedBy"]["kind"], "agent");
    assert_eq!(listed[0]["subject"]["startAt"], START);
    assert_eq!(listed[0]["subject"]["endAt"], END);
    assert_eq!(listed[0]["subject"]["conversationTitle"], "Weekend plans");
    assert!(group.actions(&group.requester).await.is_empty());
    for other in [&group.requester, &group.outsider] {
        assert_eq!(
            group.decide(other, &action_id, "approve").await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        group.notified(&action_id).await,
        vec![group.owner.account_id.clone()]
    );

    let (status, decided) = group.decide(&group.owner, &action_id, "approve").await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    assert_eq!(decided["action"]["status"], "approved");
    assert_eq!(decided["planCard"], Value::Null);
    assert_eq!(
        group.decide(&group.owner, &action_id, "approve").await.0,
        StatusCode::OK
    );
    assert_eq!(
        group.decide(&group.owner, &action_id, "decline").await.0,
        StatusCode::CONFLICT
    );

    let (status, data) = read_shared(&group, &first, (START, END)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["scope"], "owner_requested_shared_read");
    assert_eq!(data["events"][0]["title"], "Saved appointment");

    // A new request for the same window within the grant reads directly.
    let second = format!("cal-2-{}", group.tag);
    group.ask(&group.owner, &second, "and again please").await;
    let (_, data) = read_shared(&group, &second, (START, END)).await;
    assert_eq!(data["events"][0]["title"], "Saved appointment");
    assert_eq!(calendar_actions(&group).await, 1);

    // Another window asks again; an expired grant asks again too.
    let (_, other_window) = read_shared(&group, &second, (START, "2026-10-04T00:00:00Z")).await;
    assert_eq!(other_window["status"], "approval_required");
    query("UPDATE cloud_agent_pending_actions SET grant_expires_at = now() - interval '1 second' WHERE action_id = $1::uuid")
        .bind(&action_id)
        .execute(&group.pool)
        .await
        .unwrap();
    let (_, expired_grant) = read_shared(&group, &second, (START, END)).await;
    assert_eq!(expired_grant["status"], "approval_required");
}

#[tokio::test]
async fn a_decline_binds_one_request_and_waiting_requests_expire() {
    let Some(group) = Group::new("calendar-decline", false).await else {
        return;
    };
    save_event(&group).await;
    let first = format!("dec-1-{}", group.tag);
    group
        .ask(&group.owner, &first, "share my calendar here")
        .await;
    let (_, waiting) = read_shared(&group, &first, (START, END)).await;
    let action_id = waiting["pendingActionId"].as_str().unwrap().to_string();
    let (status, declined) = group.decide(&group.owner, &action_id, "decline").await;
    assert_eq!(status, StatusCode::OK, "{declined}");
    assert_eq!(declined["action"]["status"], "declined");

    let (status, answer) = read_shared(&group, &first, (START, END)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answer["status"], "declined");
    assert_eq!(
        answer["message"],
        "Olive Owner chose not to share their calendar in this chat. \
         Do not share or guess calendar details."
    );
    assert!(answer.get("events").is_none());

    // The next request asks again.
    let second = format!("dec-2-{}", group.tag);
    group
        .ask(&group.owner, &second, "please share it now")
        .await;
    let (_, waiting) = read_shared(&group, &second, (START, END)).await;
    assert_eq!(waiting["status"], "approval_required");
    let second_action = waiting["pendingActionId"].as_str().unwrap().to_string();
    assert_ne!(second_action, action_id);

    // A request nobody answered expires: it leaves the list, cannot be
    // decided, and a later read starts a fresh request.
    query("UPDATE cloud_agent_pending_actions SET expires_at = now() - interval '1 second' WHERE action_id = $1::uuid")
        .bind(&second_action)
        .execute(&group.pool)
        .await
        .unwrap();
    assert!(group.actions(&group.owner).await.is_empty());
    let (status, closed) = group.decide(&group.owner, &second_action, "approve").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(closed["errorCode"], "agent_action_closed");
    let (_, fresh) = read_shared(&group, &second, (START, END)).await;
    assert_eq!(fresh["status"], "approval_required");
    assert_ne!(fresh["pendingActionId"].as_str().unwrap(), second_action);
    // Private reads never wait.
    let (status, private) = call(
        &group.router,
        request(
            "POST",
            "/v1/cloud/calendar/read",
            Some(&group.owner.token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(private["scope"], "private_owner_read");
}
