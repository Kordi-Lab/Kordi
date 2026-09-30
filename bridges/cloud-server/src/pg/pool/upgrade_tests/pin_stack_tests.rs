use super::*;

#[tokio::test]
#[ignore = "requires a dedicated empty migration fixture"]
async fn upgrade_from_105_preserves_pins_and_rolling_writes() {
    let pool = fixture(105).await;
    let conversation = Uuid::new_v4();
    let session = format!("session:group:{conversation}");
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES($1,'group','fixture-owner',$1,'pin-stack-fixture',$2)")
        .bind(conversation).bind(&session).execute(&pool).await.unwrap();
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,'fixture-owner'),($1,'fixture-peer')")
        .bind(conversation).execute(&pool).await.unwrap();
    query("INSERT INTO cloud_session_shared_pins(session_id,message_id,updated_by_account_id,updated_at) VALUES($1,'shared','fixture-owner','2026-09-15T10:00:00Z')")
        .bind(&session).execute(&pool).await.unwrap();
    query("INSERT INTO cloud_account_session_pins(account_id,session_id,message_id,updated_at) VALUES('fixture-owner',$1,'personal','2026-09-15T10:00:00Z')")
        .bind(&session).execute(&pool).await.unwrap();
    apply_migrations(&pool).await.unwrap();
    apply_migrations(&pool).await.unwrap();
    let bootstrap = store::bootstrap(&pool, "fixture-owner").await.unwrap();
    let pin = bootstrap
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session)
        .unwrap();
    assert_eq!(pin.shared_message_ids, ["shared"]);
    assert_eq!(pin.private_message_ids, ["personal"]);
    // A legacy replica changing the scalar must update the array projection too.
    query(
        "UPDATE cloud_session_shared_pins SET message_id='legacy-replacement' WHERE session_id=$1",
    )
    .bind(&session)
    .execute(&pool)
    .await
    .unwrap();
    let ids: (Vec<String>,) =
        query_as("SELECT message_ids FROM cloud_session_shared_pins WHERE session_id=$1")
            .bind(&session)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ids.0, ["legacy-replacement"]);
    // New targeted edits can change the array while retaining its latest scalar.
    query("UPDATE cloud_session_shared_pins SET message_ids=ARRAY['earlier','legacy-replacement'] WHERE session_id=$1")
        .bind(&session).execute(&pool).await.unwrap();
    let ids: (Vec<String>,) =
        query_as("SELECT message_ids FROM cloud_session_shared_pins WHERE session_id=$1")
            .bind(&session)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ids.0, ["earlier", "legacy-replacement"]);
    assert!(query("UPDATE cloud_session_shared_pins SET message_ids=ARRAY['1','2','3','4','5','6'] WHERE session_id=$1")
        .bind(&session).execute(&pool).await.is_err());
    let peer_bootstrap = store::bootstrap(&pool, "fixture-peer").await.unwrap();
    let peer_pin = peer_bootstrap
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session)
        .unwrap();
    assert!(peer_pin.private_message_ids.is_empty());
    assert_eq!(
        peer_pin.shared_message_ids,
        ["earlier", "legacy-replacement"]
    );
}
