use super::*;

#[tokio::test]
async fn runner_explicit_artifact_export_creates_object_backed_chat_attachment() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-owner", "Owner").await;
    let requester = signup(&router, "artifact-requester", "Requester").await;
    let stranger = signup(&router, "artifact-stranger", "Stranger").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_export",
        "runner-export",
    )
    .await;

    let unexported_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_run_artifacts WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unexported_count.0, 0);

    let bytes = b"# Report\nGenerated inside the Cloud sandbox.\n";
    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-export", "report.md", "report.md", bytes),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let body = read_json(export).await;
    let attachment_id = body["artifact"]["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let message_id = body["artifact"]["messageId"].as_str().unwrap().to_string();
    assert_eq!(body["artifact"]["runId"], run_id);
    assert_eq!(body["artifact"]["name"], "report.md");
    assert_eq!(body["artifact"]["sandboxPath"], "report.md");

    let linked: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_chat_message_attachments \
         WHERE message_id::text = $1 AND attachment_id = $2",
    )
    .bind(&message_id)
    .bind(&attachment_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(linked.0, 1);

    let requester_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &requester.token,
        ))
        .await
        .unwrap();
    assert_eq!(requester_content.status(), StatusCode::OK);
    let requester_bytes = to_bytes(requester_content.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(&requester_bytes[..], bytes);

    let stranger_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &stranger.token,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_content.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runner_artifact_export_rejects_bad_auth_paths_and_sha_mismatch() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-invalid-owner", "Owner").await;
    let requester = signup(&router, "artifact-invalid-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_invalid",
        "runner-invalid",
    )
    .await;

    let user_token = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            &requester.token,
            export_body("runner-invalid", "report.md", "report.md", b"ok"),
        ))
        .await
        .unwrap();
    assert_eq!(user_token.status(), StatusCode::UNAUTHORIZED);

    for bad_path in [
        "../secret.txt",
        "/Users/owner/.ssh/id_rsa",
        "/tmp/report.md",
        "~/report.md",
    ] {
        let response = router
            .clone()
            .oneshot(post_json_with_runner_token(
                &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
                "runner-test-token",
                export_body("runner-invalid", "report.md", bad_path, b"ok"),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "path={bad_path}"
        );
    }

    let mut bad_sha = export_body("runner-invalid", "report.md", "report.md", b"ok");
    bad_sha["sha256Hex"] =
        json!("0000000000000000000000000000000000000000000000000000000000000000");
    let response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            bad_sha,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn export_before_completion_uses_stable_response_message_that_completion_updates() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-complete-owner", "Owner").await;
    let requester = signup(&router, "artifact-complete-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_complete",
        "runner-complete",
    )
    .await;

    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-complete", "report.md", "report.md", b"artifact"),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let message_id = read_json(export).await["artifact"]["messageId"]
        .as_str()
        .unwrap()
        .to_string();

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-complete", "responseText": "Here is the exported report." }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    assert_eq!(
        read_json(complete).await["run"]["responseMessageId"],
        message_id
    );

    let body = message_body(&pool, &message_id).await;
    assert!(body.starts_with("kordi-cloud-agent-response:"));
    let encoded = body.trim_start_matches("kordi-cloud-agent-response:");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .unwrap();
    let envelope: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(envelope["text"], "Here is the exported report.");
}

#[tokio::test]
async fn failed_object_upload_does_not_create_visible_placeholder_or_artifact_rows() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn_rejecting_puts().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-upload-fail-owner", "Owner").await;
    let requester = signup(&router, "artifact-upload-fail-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_upload_fail",
        "runner-upload-fail",
    )
    .await;

    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-upload-fail", "report.md", "report.md", b"report"),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::BAD_GATEWAY);

    let run_response_message: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_response_message.0, None);

    let artifact_rows: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_run_artifacts WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(artifact_rows.0, 0);
}
