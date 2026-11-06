use super::*;

// A run never reads messages from people who declined AI, on the owner's Mac
// or in the cloud runner.
#[tokio::test]
async fn context_reads_leave_out_people_who_declined_ai() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let kept = insert_test_message(
        &f.pool,
        &f.owner.account_id,
        f.conversation,
        "Synthetic owner note.",
    )
    .await;
    let hidden = insert_test_message(
        &f.pool,
        &f.peer.account_id,
        f.conversation,
        "Synthetic private peer note.",
    )
    .await;
    query("UPDATE cloud_accounts SET ai_consent_status='declined' WHERE account_id=$1")
        .bind(&f.peer.account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for member in [true, false] {
        let args = json!({"sessionId":f.session,"mode":"index","limit":20});
        let request = if member {
            member_tests::member_request(&f, None, args)
        } else {
            f.request("read_session", args)
        };
        let response = f.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json(response).await;
        let ids: Vec<&str> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["messageId"].as_str())
            .collect();
        assert!(ids.contains(&kept.as_str()), "{body}");
        assert!(!ids.contains(&hidden.as_str()), "{body}");
        assert!(!body.to_string().contains("private peer note"), "{body}");
    }
}
