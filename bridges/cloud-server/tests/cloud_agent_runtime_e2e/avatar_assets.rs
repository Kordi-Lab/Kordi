use std::io::Cursor;

use super::*;

fn patch_json_with_token(uri: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn uploaded_avatar_assets_are_reference_backed_and_renderable() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "avatar-owner", "Avatar Owner").await;
    let mut source = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(32, 24)
        .write_to(&mut source, image::ImageFormat::Png)
        .unwrap();

    let upload = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/cloud/avatar-assets?entityType=human&entityId={}",
                    owner.account_id
                ))
                .header("authorization", format!("Bearer {}", owner.token))
                .header("content-type", "image/png")
                .body(Body::from(source.into_inner()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(upload.status(), StatusCode::OK);
    let upload = read_json(upload).await;
    let marker = upload["uploadedAsset"].as_str().unwrap();
    let asset_id = marker.strip_prefix("kordi-avatar://uploaded/").unwrap();

    let updated = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &owner.token,
            json!({
                "avatarMutation": {
                    "action": "upload",
                    "uploadedAsset": marker,
                    "expectedVersion": 1,
                }
            }),
        ))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated = read_json(updated).await;
    assert_eq!(updated["avatarUrl"], marker);
    assert_eq!(updated["avatar"]["uploadedAsset"], marker);
    assert!(!updated.to_string().contains("data:image/"));

    let rendered = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/avatars/assets/{asset_id}/128.jpg"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rendered.status(), StatusCode::OK);
    assert_eq!(rendered.headers()["content-type"], "image/jpeg");
    let bytes = to_bytes(rendered.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    assert!(bytes.starts_with(b"\xff\xd8\xff"));
}
