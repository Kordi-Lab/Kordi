use super::group_avatars::{avatar_asset, control, group};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

#[tokio::test]
async fn group_avatars_store_only_the_canonical_uploaded_reference() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "avatar-canonical-owner").await;
    let peer = account(&pool, "avatar-canonical-member").await;
    connect_accounts(&pool, &owner, &peer).await;
    let space = format!("session:group:{}", Uuid::now_v7());
    let root = group(&pool, &owner, &peer, &space).await;
    let image = avatar_asset(&pool, &owner).await;
    let variants = [
        format!(" {image}"),
        format!("{image}\n"),
        format!("{image}?x"),
        format!("{image}#x"),
        image.replacen("uploaded", "uploaded:80", 1),
        image.replacen("//", "//user@", 1),
    ];
    // A new group's first image is held to the same rule as a later edit.
    let invite = store::send_message(
        &pool,
        &owner,
        root,
        control(
            "group-invite",
            &space,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": variants[0], "updatedAtMs": 1})),
        ),
    )
    .await;
    assert!(matches!(invite, Err(StoreError::InvalidInput(_))));
    store::send_message(
        &pool,
        &owner,
        root,
        control("group-invite", &space, &space, &owner, &peer, None),
    )
    .await
    .unwrap();
    for variant in &variants {
        let result = store::send_message(
            &pool,
            &owner,
            root,
            control(
                "group-avatar-update",
                &space,
                &space,
                &owner,
                &peer,
                Some(json!({"imageUrl": variant, "updatedAtMs": 1})),
            ),
        )
        .await;
        assert!(
            matches!(result, Err(StoreError::InvalidInput(_))),
            "{variant:?} must be refused"
        );
    }
    let untouched = store::bootstrap(&pool, &peer).await.unwrap();
    assert!(untouched
        .conversations
        .iter()
        .find(|c| c.id == root)
        .unwrap()
        .group_avatar
        .is_none());

    let accepted = store::send_message(
        &pool,
        &owner,
        root,
        control(
            "group-avatar-update",
            &space,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": image, "updatedAtMs": 1})),
        ),
    )
    .await
    .unwrap()
    .value;
    let text = accepted.content["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .strip_prefix("kordi-cloud-group:")
        .unwrap();
    let envelope: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(text).unwrap()).unwrap();
    assert_eq!(envelope["groupAvatar"]["imageUrl"], image);
    let reloaded = store::bootstrap(&pool, &peer).await.unwrap();
    assert_eq!(
        reloaded
            .conversations
            .iter()
            .find(|c| c.id == root)
            .unwrap()
            .group_avatar
            .as_ref()
            .unwrap()["imageUrl"],
        image
    );
}
