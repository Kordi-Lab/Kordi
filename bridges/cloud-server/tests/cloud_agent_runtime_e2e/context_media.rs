use super::*;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use std::collections::HashMap;
use tokio::sync::{Mutex, Notify};

#[path = "../../../../agent/crates/provider/tests/support/images.rs"]
mod images;

struct Fixture {
    pool: PgPool,
    router: axum::Router,
    owner: TestAccount,
    peer: TestAccount,
    session: String,
    conversation: uuid::Uuid,
    run_id: String,
    claim: uuid::Uuid,
    first: String,
    second: String,
    attachment: String,
    second_attachment: String,
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    gate: Arc<Mutex<bool>>,
    started: Arc<Notify>,
    release: Arc<Notify>,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let pool = try_pool().await?;
        let objects = Arc::new(Mutex::new(HashMap::<String, Vec<u8>>::new()));
        let gate = Arc::new(Mutex::new(false));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (data, paused, begun, proceed) = (
            objects.clone(),
            gate.clone(),
            started.clone(),
            release.clone(),
        );
        let store = axum::Router::new().fallback(move |uri: axum::extract::OriginalUri| {
            let (data, paused, begun, proceed) =
                (data.clone(), paused.clone(), begun.clone(), proceed.clone());
            async move {
                if *paused.lock().await {
                    begun.notify_one();
                    proceed.notified().await;
                }
                let key = uri
                    .0
                    .path()
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_string();
                match data.lock().await.get(&key).cloned() {
                    Some(bytes) => (StatusCode::OK, bytes),
                    None => (StatusCode::NOT_FOUND, vec![]),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, store).await.unwrap() });
        let s3 = kordi_cloud_server::attachments::S3Config {
            endpoint: url::Url::parse(&format!("http://{addr}")).unwrap(),
            region: "test".into(),
            bucket: "test".into(),
            access_key: "test-access".into(),
            secret_key: "test-secret".into(),
        };
        let router = test_router(Arc::new(
            ServerState::new(pool.clone(), EventBus::noop()).with_s3(s3),
        ));
        let owner = signup(&router, "context-owner", "Owner").await;
        let peer = signup(&router, "context-peer", "Requester").await;
        accept_contacts(&router, &owner, &peer).await;
        query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
            .bind(&owner.account_id)
            .execute(&pool)
            .await
            .unwrap();
        let session = format!("session:group:{}", uuid::Uuid::new_v4());
        let conversation = create_test_conversation(
            &pool,
            &owner.account_id,
            &session,
            ConversationKind::Group,
            vec![peer.account_id.clone()],
        )
        .await;
        let first = insert_test_message(&pool, &peer.account_id, conversation, "First image").await;
        let second = insert_test_message(
            &pool,
            &peer.account_id,
            conversation,
            "Compare this image with the earlier image",
        )
        .await;
        let attachment = Self::attach(&pool, &peer, &first, images::RED_BLUE, &objects).await;
        let second_attachment =
            Self::attach(&pool, &peer, &second, images::GREEN_WHITE, &objects).await;
        let agent = format!("cloud-agent:{}", owner.account_id);
        let ready = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &owner.token,
                json!({"agentIds":[agent]}),
            ))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let body = json!({"kind":"group-message","groupId":session,"groupSpaceId":session,"createdByAccountId":owner.account_id,"actor":{"accountId":peer.account_id,"displayName":"Requester"},"participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],"message":{"id":uuid::Uuid::new_v4(),"senderAccountId":peer.account_id,"senderKind":"human","text":"@Kordi","createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":agent,"targetCloudAgentOwnerAccountId":owner.account_id}});
        let wire = insert_test_message(
            &pool,
            &peer.account_id,
            conversation,
            &format!(
                "kordi-cloud-group:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.to_string())
            ),
        )
        .await;
        let claim = uuid::Uuid::new_v4();
        let claimed=router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/desktop/claim",&owner.token,json!({"claimId":claim,"requestMessageId":wire,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":peer.account_id,"prompt":"@Kordi","idempotencyKey":format!("context:{claim}")}))).await.unwrap();
        assert_eq!(claimed.status(), StatusCode::OK);
        let claimed = read_json(claimed).await;
        assert_eq!(claimed["acquired"], true);
        assert_eq!(claimed["contextSessionId"], session);
        let run_id = claimed["runId"].as_str().unwrap().to_string();
        // Keep the fixture lease alive independently of test scheduling delays.
        query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text WHERE run_id=$1").bind(&run_id).execute(&pool).await.unwrap();
        Some(Self {
            pool,
            router,
            owner,
            peer,
            session,
            conversation,
            run_id,
            claim,
            first,
            second,
            attachment,
            second_attachment,
            objects,
            gate,
            started,
            release,
        })
    }

    async fn attach(
        pool: &PgPool,
        peer: &TestAccount,
        message: &str,
        bytes: &[u8],
        objects: &Arc<Mutex<HashMap<String, Vec<u8>>>>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        objects.lock().await.insert(id.clone(), bytes.to_vec());
        query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES($1,$2,$1,'image/png',$3,now()::text,now()::text)")
            .bind(&id).bind(&peer.account_id).bind(bytes.len() as i64).execute(pool).await.unwrap();
        query("INSERT INTO cloud_chat_message_attachments(message_id,attachment_id,position) VALUES($1::text::uuid,$2,0)").bind(message).bind(&id).execute(pool).await.unwrap();
        id
    }

    fn args(&self, id: &str, attachment: &str) -> Value {
        json!({"sessionId":self.session,"mode":"attachment","messageIds":[id],"attachmentId":attachment,"expectedVersion":1})
    }
    fn request(&self, tool: &str, args: Value) -> Request<Body> {
        post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/context", self.run_id),
            &self.owner.token,
            json!({"claimId":self.claim,"tool":tool,"arguments":args}),
        )
    }
    async fn read(&self, args: Value) -> axum::response::Response {
        self.router
            .clone()
            .oneshot(self.request("read_session", args))
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn desktop_history_and_both_images_are_available_without_local_projection() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let (prompt,): (String,) = sqlx_core::query_as::query_as(
        "SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&f.run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(prompt.contains(&f.attachment));
    assert!(prompt.contains(&f.second_attachment));
    assert!(!prompt.contains(&base64::engine::general_purpose::STANDARD.encode(images::RED_BLUE)));
    query("UPDATE cloud_chat_messages SET content='{\"schema\":1,\"blocks\":[]}'::jsonb WHERE message_id::text=$1").bind(&f.first).execute(&f.pool).await.unwrap();
    let index = f.read(json!({"sessionId":f.session,"mode":"index"})).await;
    assert_eq!(index.status(), StatusCode::OK);
    let index = read_json(index).await;
    let parsed: kordi_tools::ReadSessionResponse = serde_json::from_value(index.clone()).unwrap();
    assert_eq!(
        parsed
            .messages
            .iter()
            .map(|m| m.attachments.len())
            .sum::<usize>(),
        2
    );
    assert!(!index.to_string().contains("data:image"));
    for (id, attachment, bytes) in [
        (&f.first, &f.attachment, images::RED_BLUE),
        (&f.second, &f.second_attachment, images::GREEN_WHITE),
    ] {
        let read = f.read(f.args(id, attachment)).await;
        assert_eq!(read.status(), StatusCode::OK);
        let read = read_json(read).await;
        assert_eq!(
            read["media"][0]["data"],
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        assert_eq!(read["media"][0]["mime_type"], "image/png");
        assert!(!read.to_string().contains("http://"));
    }
    let search = f
        .router
        .clone()
        .oneshot(f.request(
            "search_sessions",
            json!({"query":"Compare","includeMessages":true}),
        ))
        .await
        .unwrap();
    assert_eq!(search.status(), StatusCode::OK);
    let search: kordi_tools::SearchSessionsResponse =
        serde_json::from_value(read_json(search).await).unwrap();
    assert!(search.sessions[0].snippets[0].text.contains("Compare"));
    assert_eq!(
        f.read(json!({"sessionId":"another-session","mode":"index"}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let wrong = post_json_with_token(
        &format!("/v1/cloud/agent-runs/desktop/{}/context", f.run_id),
        &f.peer.token,
        json!({"claimId":f.claim,"tool":"read_session","arguments":{"sessionId":f.session}}),
    );
    assert_eq!(
        f.router.clone().oneshot(wrong).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn chat_media_rechecks_message_versions_hiding_and_deleted_sources() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    query("UPDATE cloud_chat_messages SET version=version+1 WHERE message_id::text=$1")
        .bind(&f.first)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.read(f.args(&f.first, &f.attachment)).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut args = f.args(&f.first, &f.attachment);
    args["expectedVersion"] = json!(2);
    assert_eq!(f.read(args.clone()).await.status(), StatusCode::OK);
    query("INSERT INTO cloud_chat_attachment_visibility(account_id,message_id,attachment_id) VALUES($1,$2::text::uuid,$3)").bind(&f.peer.account_id).bind(&f.first).bind(&f.attachment).execute(&f.pool).await.unwrap();
    assert_eq!(f.read(args).await.status(), StatusCode::NOT_FOUND);
    query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2::text::uuid)").bind(&f.owner.account_id).bind(&f.second).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.read(f.args(&f.second, &f.second_attachment))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let index = read_json(f.read(json!({"sessionId":f.session,"mode":"index"})).await).await;
    assert!(!index.to_string().contains(&f.attachment));
    assert!(!index.to_string().contains(&f.second_attachment));
    query("UPDATE cloud_chat_messages SET deleted_at=now() WHERE message_id::text=$1")
        .bind(&f.first)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.read(f.args(&f.first, &f.attachment)).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn chat_media_denies_revocation_during_download_and_expired_leases() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    *f.gate.lock().await = true;
    let request = f.request("read_session", f.args(&f.first, &f.attachment));
    let router = f.router.clone();
    let reading = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(5), f.started.notified())
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2").bind(f.conversation).bind(&f.peer.account_id).execute(&f.pool).await.unwrap();
    f.release.notify_one();
    assert_eq!(reading.await.unwrap().status(), StatusCode::NOT_FOUND);
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 minute')::text WHERE run_id=$1").bind(&f.run_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.read(json!({"sessionId":f.session,"mode":"index"}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn cloud_runner_reads_the_same_authorized_image_contract() {
    struct RestoreRunnerToken(Option<std::ffi::OsString>);
    impl Drop for RestoreRunnerToken {
        fn drop(&mut self) {
            if let Some(value) = &self.0 {
                std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", value);
            } else {
                std::env::remove_var("KORDI_CLOUD_RUNNER_TOKEN");
            }
        }
    }
    let _restore = RestoreRunnerToken(std::env::var_os("KORDI_CLOUD_RUNNER_TOKEN"));
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let Some(f) = Fixture::new().await else {
        return;
    };
    // Reassign only the fixture run to simulate the admitted cloud executor.
    query("UPDATE cloud_agent_fallback_runs SET execution_backend='cloud',claimed_by='media-fixture-runner' WHERE run_id=$1").bind(&f.run_id).execute(&f.pool).await.unwrap();
    let response=f.router.clone().oneshot(post_json_with_runner_token(&format!("/v1/cloud/agent-runs/{}/context",f.run_id),"runner-test-token",json!({"runnerId":"media-fixture-runner","tool":"read_session","arguments":f.args(&f.first,&f.attachment)}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value = read_json(response).await;
    assert_eq!(
        value["media"][0]["data"],
        base64::engine::general_purpose::STANDARD.encode(images::RED_BLUE)
    );
    f.objects.lock().await.clear();
}

#[path = "context_media/member_tests.rs"]
mod member_tests;
