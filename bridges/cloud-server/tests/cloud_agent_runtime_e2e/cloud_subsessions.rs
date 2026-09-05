use super::*;

#[tokio::test]
async fn cloud_subsession_spawn_is_idempotent_fenced_and_keeps_results_out_of_parent() {
    let Some(pool)=try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN","subsession-runner-test");
    let router=test_router(Arc::new(ServerState::new(pool.clone(),EventBus::noop())));
    let owner=signup(&router,"cloud-sub-owner","Owner").await;
    let peer=signup(&router,"cloud-sub-peer","Requester").await;
    let outsider=signup(&router,"cloud-sub-outsider","Outsider").await;
    accept_contacts(&router,&owner,&peer).await;
    let offline=router.clone().oneshot(post_with_token("/v1/cloud/presence/offline",&owner.token)).await.unwrap();
    assert_eq!(offline.status(),StatusCode::OK);

    for (group,in_thread) in [(true,false),(false,false),(true,true)] {
        let session_id=if group {format!("session:group:{}",uuid::Uuid::new_v4())} else {
            let mut members=[owner.account_id.clone(),peer.account_id.clone()]; members.sort();
            format!("session:direct-person:{}:{}",members[0],members[1])
        };
        let conversation=create_test_conversation(&pool,&owner.account_id,&session_id,if group {ConversationKind::Group} else {ConversationKind::Direct},vec![peer.account_id.clone()]).await;
        let root=insert_test_message(&pool,&peer.account_id,conversation,"Discussion root").await;
        let action=if in_thread {json!({"schemaVersion":1,"kind":"thread","source":{"sourceSessionId":session_id,"sourceMessageId":root,"senderLabel":"Requester","textPreview":"Discussion root","attachmentCount":0}})} else {Value::Null};
        let logical=uuid::Uuid::new_v4().to_string();
        let message=json!({"schemaVersion":1,"kind":"message","id":logical,"senderAccountId":peer.account_id,"senderKind":"human","text":"Research independently","createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id,"messageAction":action});
        let envelope=if group {json!({"kind":"group-message","groupId":session_id,"groupSpaceId":session_id,"createdByAccountId":owner.account_id,"actor":{"accountId":peer.account_id,"displayName":"Requester","role":"person"},"participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],"message":message})} else {message};
        let body=format!("{}:{}",if group {"kordi-cloud-group"} else {"kordi-cloud-message"},base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string()));
        let wire=insert_test_message(&pool,&peer.account_id,conversation,&body).await;
        let request=if group {logical} else {wire};
        let claim=router.clone().oneshot(post_json_with_token("/v1/cloud/agent-runs/claim",&peer.token,claim_body_with_session(&owner,&peer,&request,&session_id))).await.unwrap();
        assert_eq!(claim.status(),StatusCode::OK);
        let parent=read_json(claim).await["runId"].as_str().unwrap().to_string();
        let runner_post=|uri:&str,value:Value|post_json_with_runner_token(uri,"subsession-runner-test",value);
        let lease=router.clone().oneshot(runner_post("/v1/cloud/agent-runs/lease",json!({"runnerId":"parent-executor","canaryRunId":parent}))).await.unwrap();
        assert_eq!(lease.status(),StatusCode::OK);
        assert_eq!(read_json(lease).await["run"]["runId"],parent);
        let uri=format!("/v1/cloud/agent-runs/{parent}/task-operator");
        let input=json!({"runnerId":"parent-executor","toolCallId":"spawn-call","arguments":{"action":"spawn","taskName":"research","taskTitle":"Research task","message":"Compare sources independently","forkTurns":"none"}});
        let before:(i64,)=sqlx_core::query_as::query_as("SELECT count(*) FROM cloud_chat_conversations").fetch_one(&pool).await.unwrap();
        let created=router.clone().oneshot(runner_post(&uri,input.clone())).await.unwrap();
        assert_eq!(created.status(),StatusCode::OK);
        let created=read_json(created).await;
        let id=created["sessionId"].as_str().unwrap();
        let replay=router.clone().oneshot(runner_post(&uri,input.clone())).await.unwrap();
        assert_eq!(read_json(replay).await["sessionId"],id);
        let (child,agent,parent_request):(String,String,String)=sqlx_core::query_as::query_as("SELECT r.run_id,r.execution_agent_id,s.parent_request_id FROM cloud_agent_fallback_runs r JOIN cloud_agent_subsessions s ON s.subsession_id=r.subsession_id WHERE s.subsession_id=$1")
            .bind(uuid::Uuid::parse_str(id).unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(agent,format!("cloud-agent:{}",owner.account_id));
        assert_eq!(parent_request,request);
        let mut wrong=input.clone(); wrong["runnerId"]=json!("stale-executor");
        assert!(!router.clone().oneshot(runner_post(&uri,wrong)).await.unwrap().status().is_success());
        let completed=router.clone().oneshot(runner_post(&format!("/v1/cloud/agent-runs/{parent}/complete"),json!({"runnerId":"parent-executor","responseText":"Research started in its own session."}))).await.unwrap();
        assert_eq!(completed.status(),StatusCode::OK);
        let parent_response=read_json(completed).await["run"]["responseMessageId"].as_str().unwrap().to_string();
        let parent_body=message_body(&pool,&parent_response).await;
        let (_,encoded)=parent_body.split_once(':').unwrap();
        let payload:Value=serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        if group {
            assert!(payload["message"]["structuredContent"]["tools"][0]["resultText"].as_str().unwrap().contains(id));
            assert_eq!(payload["message"]["messageAction"],action);
        } else { assert_eq!(payload["backgroundSessions"][0]["sessionId"],id); }
        assert!(!router.clone().oneshot(runner_post(&uri,input)).await.unwrap().status().is_success());
        let lease=router.clone().oneshot(runner_post("/v1/cloud/agent-runs/lease",json!({"runnerId":"child-executor","canaryRunId":child}))).await.unwrap();
        assert_eq!(read_json(lease).await["run"]["subsessionId"],id);
        let context=router.clone().oneshot(runner_post(&format!("/v1/cloud/agent-runs/{child}/context"),json!({"runnerId":"child-executor","tool":"read_session","arguments":{"sessionId":session_id,"mode":"index"}}))).await.unwrap();
        assert_eq!(context.status(),StatusCode::OK);
        let progress=router.clone().oneshot(runner_post(&format!("/v1/cloud/agent-runs/{child}/subsession-progress"),json!({"runnerId":"child-executor","toolCallId":"search-one","toolName":"web_search"}))).await.unwrap();
        assert_eq!(progress.status(),StatusCode::OK);
        let completed=router.clone().oneshot(runner_post(&format!("/v1/cloud/agent-runs/{child}/complete"),json!({"runnerId":"child-executor","responseText":"CHILD_ONLY_RESULT"}))).await.unwrap();
        assert_eq!(completed.status(),StatusCode::OK);
        assert!(read_json(completed).await["run"]["responseMessageId"].is_null());
        let uri=format!("/v1/cloud/agent-subsessions/{id}?includeMessages=true");
        let result=router.clone().oneshot(get_with_token(&uri,&peer.token)).await.unwrap();
        assert_eq!(result.status(),StatusCode::OK);
        let result=read_json(result).await;
        assert_eq!(result["status"],"done");
        assert_eq!(result["agentId"],agent);
        assert!(result["messages"].as_array().unwrap().iter().any(|message|message["text"]=="CHILD_ONLY_RESULT"));
        assert_eq!(router.clone().oneshot(get_with_token(&uri,&outsider.token)).await.unwrap().status(),StatusCode::NOT_FOUND);
        assert_eq!(message_body(&pool,&parent_response).await,parent_body);
        let after:(i64,)=sqlx_core::query_as::query_as("SELECT count(*) FROM cloud_chat_conversations").fetch_one(&pool).await.unwrap();
        assert_eq!(before,after,"a subsession must not create a conversation channel");
    }
    println!("CLOUD_SUBSESSION_EXECUTION_AND_PLACEMENT_VERIFIED");
}
