use super::*;

#[tokio::test]
async fn shared_desktop_lease_resolves_ids_and_publishes_once() {
    let Some(pool)=try_pool().await else{return};
    let router=test_router(Arc::new(ServerState::new(pool.clone(),EventBus::noop())));
    let owner=signup(&router,"shared-lease-owner","Owner").await;
    let peer=signup(&router,"shared-lease-peer","Requester").await;
    accept_contacts(&router,&owner,&peer).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1").bind(&owner.account_id).execute(&pool).await.unwrap();
    let agent=format!("cloud-agent:{}",owner.account_id);
    let ready=router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/desktop/ready",&owner.token,json!({"agentIds":[agent]}))).await.unwrap();
    assert_eq!(ready.status(),StatusCode::OK);
    // Explicit fixture clocks make the admission checks independent of a test tunnel.
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1").bind(&agent).execute(&pool).await.unwrap();
    for group in [true,false] {
        let session=if group {format!("session:group:{}",uuid::Uuid::new_v4())} else {let mut ids=[owner.account_id.clone(),peer.account_id.clone()];ids.sort();format!("session:direct-person:{}:{}",ids[0],ids[1])};
        let conversation=create_test_conversation(&pool,&owner.account_id,&session,if group {ConversationKind::Group}else{ConversationKind::Direct},vec![peer.account_id.clone()]).await;
        let logical=uuid::Uuid::new_v4().to_string();
        let request=json!({"schemaVersion":1,"kind":"message","id":logical,"senderAccountId":peer.account_id,"senderKind":"human","text":"Reply once","createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":agent,"targetCloudAgentOwnerAccountId":owner.account_id});
        let group_body=|message:Value|json!({"kind":"group-message","groupId":session,"groupSpaceId":session,"createdByAccountId":owner.account_id,"actor":{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},"participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],"message":message});
        let envelope=if group {group_body(request)} else {request};
        let encode=|prefix:&str,value:Value|format!("{prefix}:{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string()));
        let wire=insert_test_message(&pool,&peer.account_id,conversation,&encode(if group {"kordi-cloud-group"}else{"kordi-cloud-message"},envelope)).await;
        let claim_id=uuid::Uuid::new_v4();
        let input=|request:&str,claim:uuid::Uuid|json!({"claimId":claim,"requestMessageId":request,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":peer.account_id,"prompt":"Reply once","idempotencyKey":format!("shared:{claim}")});
        let claimed=router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/desktop/claim",&owner.token,input(&wire,claim_id))).await.unwrap();
        assert_eq!(claimed.status(),StatusCode::OK);
        let claimed=read_json(claimed).await;
        assert_eq!(claimed["acquired"],true);
        let run=claimed["runId"].as_str().unwrap();
        let canonical=if group {logical.as_str()}else{wire.as_str()};
        let replay=router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/desktop/claim",&owner.token,input(canonical,uuid::Uuid::new_v4()))).await.unwrap();
        assert_eq!(replay.status(),StatusCode::OK);
        let replay=read_json(replay).await;
        assert_eq!(replay["runId"],run);
        assert_eq!(replay["acquired"],false);
        sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text WHERE run_id=$1").bind(run).execute(&pool).await.unwrap();
        assert!(kordi_cloud_server::cloud_agent_runtime::runs::lease_canary_run(&pool,"cloud-contender",run).await.unwrap().is_none());
        let admitted=router.clone().oneshot(post_json_with_token(&format!("/v1/cloud/agent-runs/desktop/{run}/admit"),&owner.token,json!({"claimId":claim_id}))).await.unwrap();
        assert_eq!(read_json(admitted).await["admitted"],true);
        let response=if group {group_body(json!({"id":"native-response","senderAccountId":owner.account_id,"senderAgentId":agent,"senderKind":"agent","text":"ACK","createdAtMs":chrono::Utc::now().timestamp_millis(),"requestId":canonical,"deliveryState":"complete"}))}else{json!({"kind":"agent-response","requestId":canonical,"text":"ACK","deliveryState":"complete"})};
        let publication=json!({"claimId":claim_id,"clientMessageId":uuid::Uuid::new_v4(),"body":encode(if group{"kordi-cloud-group"}else{"kordi-cloud-agent-response"},response)});
        let uri=format!("/v1/cloud/agent-runs/desktop/{run}/progress");
        let first=router.clone().oneshot(post_json_with_token(&uri,&owner.token,publication.clone())).await.unwrap();
        assert_eq!(first.status(),StatusCode::OK);
        let first=read_json(first).await;
        let second=router.clone().oneshot(post_json_with_token(&uri,&owner.token,publication)).await.unwrap();
        assert_eq!(second.status(),StatusCode::OK);
        assert_eq!(read_json(second).await["messageId"],first["messageId"]);
        assert!(kordi_cloud_server::cloud_agent_runtime::runs::lease_canary_run(&pool,"cloud-contender",run).await.unwrap().is_none());
    }
    println!("SHARED_DESKTOP_LEASE_AND_PUBLICATION_VERIFIED");
}
