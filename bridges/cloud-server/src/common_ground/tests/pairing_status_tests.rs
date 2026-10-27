use super::{account, app, json, person, pool, send, CG};

#[tokio::test]
async fn pairing_status_is_owner_scoped_and_tracks_repeat_scans() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "pair_status_service").await;
    let app = app(&pool, Some(&service));
    let owner = person(&app, &pool, "PairOwner", true).await;
    let scanner = person(&app, &pool, "PairScanner", true).await;
    let status_path = format!("{CG}/pairings/status");
    for _ in 0..2 {
        let (_, issued) = send(
            &app,
            "POST",
            &format!("{CG}/pairings/code"),
            &owner.token,
            Some(json!({"profileId": owner.health})),
        )
        .await;
        let body = json!({"code": issued["code"]});
        let (status, waiting) =
            send(&app, "POST", &status_path, &owner.token, Some(body.clone())).await;
        assert_eq!(status, 200);
        assert_eq!(waiting["status"], "waiting");
        let (status, _) = send(
            &app,
            "POST",
            &status_path,
            &scanner.token,
            Some(body.clone()),
        )
        .await;
        assert_eq!(
            status, 404,
            "Knowing a code does not disclose its owner's status"
        );
        let (status, _) = send(
            &app,
            "POST",
            &format!("{CG}/pairings/redeem"),
            &scanner.token,
            Some(json!({"code": issued["code"], "profileId": scanner.health})),
        )
        .await;
        assert_eq!(status, 200);
        for _ in 0..2 {
            let (status, paired) =
                send(&app, "POST", &status_path, &owner.token, Some(body.clone())).await;
            assert_eq!(status, 200);
            assert_eq!(paired["status"], "paired");
            assert_eq!(paired["person"]["person"]["accountId"], scanner.id);
            assert_eq!(paired["person"]["profileId"], owner.health);
            assert_eq!(
                paired["person"]["card"]["workingOn"],
                json!(["PairScanner health topic"])
            );
        }
    }
    let (_, issued) = send(
        &app,
        "POST",
        &format!("{CG}/pairings/code"),
        &owner.token,
        Some(json!({"profileId": owner.work})),
    )
    .await;
    sqlx_core::query::query("UPDATE cloud_common_ground_pairing_codes SET expires_at = now() - interval '1 second' WHERE account_id = $1")
        .bind(&owner.id).execute(&pool).await.unwrap();
    let (_, expired) = send(
        &app,
        "POST",
        &status_path,
        &owner.token,
        Some(json!({"code": issued["code"]})),
    )
    .await;
    assert_eq!(expired["status"], "expired");
    assert!(expired.get("person").is_none());
}
