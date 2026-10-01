use super::*;
use kordi_cloud_server::cloud_agent_runtime::sandboxes::{
    hashed_workspace_key, raw_workspace_key, SandboxScope,
};

async fn sandbox_key(group: &Group, run_id: &str) -> (String, String) {
    query_as(
        "SELECT sandbox.sandbox_id, sandbox.workspace_key
         FROM cloud_agent_fallback_runs run
         JOIN cloud_agent_sandboxes sandbox ON sandbox.sandbox_id = run.sandbox_id
         WHERE run.run_id = $1",
    )
    .bind(run_id)
    .fetch_one(&group.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn group_requesters_get_their_own_workspace_and_the_owner_keeps_the_shared_one() {
    let Some(group) = Group::new("authority-sandboxes").await else {
        return;
    };
    let tag = group.tag.clone();
    let mut runs = Vec::new();
    for (index, requester) in [&group.requester, &group.member2, &group.owner]
        .into_iter()
        .enumerate()
    {
        let id = format!("s{index}-{tag}");
        group.ask(requester, &id, "make a file", None).await;
        let (status, body) = group.claim_cloud(requester, &id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        runs.push(body["runId"].as_str().unwrap().to_string());
    }
    let first = sandbox_key(&group, &runs[0]).await;
    let second = sandbox_key(&group, &runs[1]).await;
    let owner = sandbox_key(&group, &runs[2]).await;
    assert_ne!(first.0, second.0, "requesters never share a workspace");
    assert_ne!(first.0, owner.0);
    assert_eq!(
        owner.1,
        hashed_workspace_key(&raw_workspace_key(
            &group.session,
            &group.owner.account_id,
            &group.owner.account_id,
            SandboxScope::SharedSession,
        )),
        "the owner keeps the group's existing workspace"
    );
    assert_eq!(
        first.1,
        hashed_workspace_key(&raw_workspace_key(
            &group.session,
            &group.owner.account_id,
            &group.requester.account_id,
            SandboxScope::RequesterIsolated,
        ))
    );
}

#[tokio::test]
async fn runs_never_exceed_what_their_requester_may_do() {
    let Some(group) = Group::new("authority-runs").await else {
        return;
    };
    let tag = group.tag.clone();
    let request_id = format!("q-{tag}");
    group.ask(&group.requester, &request_id, "help", None).await;
    let (status, run) = group.claim_cloud(&group.requester, &request_id).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let run_id = run["runId"].as_str().unwrap().to_string();
    let token = group.lease_for_runner(&run_id).await;
    // Positive control: the run reads its own conversation.
    let (status, _) = group
        .runner_read(
            &run_id,
            &token,
            "read_session",
            json!({"sessionId": group.session, "mode": "index"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // Another conversation is out of reach.
    let (status, _) = group
        .runner_read(
            &run_id,
            &token,
            "read_session",
            json!({"sessionId": format!("session:group:{}", Uuid::new_v4()), "mode": "index"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Only the owner's own request may read the owner's calendar.
    let (status, _) = group
        .runner_read(&run_id, &token, "read_calendar", json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A requester who left takes their run's access with them.
    query("UPDATE cloud_chat_conversation_members SET membership_state='left', left_at=now() WHERE conversation_id=$1 AND account_id=$2")
        .bind(group.conversation)
        .bind(&group.requester.account_id)
        .execute(&group.pool)
        .await
        .unwrap();
    let (status, _) = group
        .runner_read(
            &run_id,
            &token,
            "read_session",
            json!({"sessionId": group.session, "mode": "index"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A removed requester can no longer start runs either.
    let later = format!("later-{tag}");
    let (status, _) = group.claim_cloud(&group.requester, &later).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
