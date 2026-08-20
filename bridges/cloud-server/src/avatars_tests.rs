use super::*;

const ONE_PIXEL_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

#[test]
fn generated_marker_round_trips() {
    let marker = generated_avatar_marker(HUMAN_AVATAR_STYLE, "acct_123", 7);
    assert_eq!(
        parse_generated_avatar_marker(&marker),
        Some(GeneratedAvatarMarker {
            renderer_version: AVATAR_RENDERER_VERSION.to_string(),
            style: HUMAN_AVATAR_STYLE.to_string(),
            seed: "acct_123".to_string(),
            version: 7,
        })
    );
}

#[test]
fn renderer_is_deterministic_for_every_pinned_style() {
    for style in [HUMAN_AVATAR_STYLE, AGENT_AVATAR_STYLE] {
        let first = render_png(style, "stable_seed").expect("render avatar");
        let second = render_png(style, "stable_seed").expect("render avatar again");
        assert_eq!(first, second);
        assert!(first.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}

#[tokio::test]
async fn preview_route_renders_lorelei_and_thumbs_pngs() {
    for style in [HUMAN_AVATAR_STYLE, AGENT_AVATAR_STYLE] {
        let response = render_avatar_preview(
            Extension(Arc::new(CloudRateLimiter::memory(
                CloudRateLimitConfig::production(),
            ))),
            None,
            HeaderMap::new(),
            Path((style.to_string(), "preview_seed.png".to_string())),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read rendered avatar");
        assert!(body.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}

#[test]
fn upload_mutation_keeps_generated_seed() {
    let current = AvatarDescriptor {
        entity_type: "human".to_string(),
        entity_id: "acct_123".to_string(),
        source: "generated".to_string(),
        style: HUMAN_AVATAR_STYLE.to_string(),
        seed: "acct_123".to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 1,
        updated_at: "before".to_string(),
    };
    let next = apply_avatar_mutation(
        &current,
        &AvatarMutationRequest {
            action: "upload".to_string(),
            uploaded_asset: Some(ONE_PIXEL_PNG.to_string()),
            seed: None,
            expected_version: Some(1),
        },
        "after",
    )
    .expect("apply upload");
    assert_eq!(next.seed, current.seed);
    assert_eq!(next.source, "uploaded");
    assert_eq!(next.version, 2);
}

#[test]
fn removing_an_upload_restores_the_same_generated_identity() {
    let current = AvatarDescriptor {
        entity_type: "agent".to_string(),
        entity_id: "agent_123".to_string(),
        source: "uploaded".to_string(),
        style: AGENT_AVATAR_STYLE.to_string(),
        seed: "stable_agent_seed".to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: Some(ONE_PIXEL_PNG.to_string()),
        version: 4,
        updated_at: "before".to_string(),
    };
    let next = apply_avatar_mutation(
        &current,
        &AvatarMutationRequest {
            action: "remove_upload".to_string(),
            uploaded_asset: None,
            seed: None,
            expected_version: Some(4),
        },
        "after",
    )
    .expect("remove upload");

    assert_eq!(next.source, "generated");
    assert_eq!(next.seed, "stable_agent_seed");
    assert_eq!(
        next.image_url(),
        generated_avatar_marker(AGENT_AVATAR_STYLE, "stable_agent_seed", 5)
    );
}

#[test]
fn stale_avatar_mutations_are_rejected() {
    let current = AvatarDescriptor {
        entity_type: "human".to_string(),
        entity_id: "acct_123".to_string(),
        source: "generated".to_string(),
        style: HUMAN_AVATAR_STYLE.to_string(),
        seed: "stable_human_seed".to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 3,
        updated_at: "before".to_string(),
    };
    let result = apply_avatar_mutation(
        &current,
        &AvatarMutationRequest {
            action: "regenerate".to_string(),
            uploaded_asset: None,
            seed: Some("next_seed".to_string()),
            expected_version: Some(2),
        },
        "after",
    );

    assert_eq!(result, Err(AvatarMutationError::Conflict));
}

#[test]
fn regenerate_requires_an_explicit_seed() {
    let current = AvatarDescriptor {
        entity_type: "human".to_string(),
        entity_id: "acct_123".to_string(),
        source: "generated".to_string(),
        style: HUMAN_AVATAR_STYLE.to_string(),
        seed: "stable_human_seed".to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 1,
        updated_at: "before".to_string(),
    };
    let result = apply_avatar_mutation(
        &current,
        &AvatarMutationRequest {
            action: "regenerate".to_string(),
            uploaded_asset: None,
            seed: None,
            expected_version: Some(1),
        },
        "after",
    );

    assert!(matches!(result, Err(AvatarMutationError::Invalid(_))));
}

#[test]
fn avatar_rate_limit_uses_forwarded_ips_only_from_private_proxies() {
    let mut headers = HeaderMap::new();
    headers.insert("x-real-ip", "203.0.113.8".parse().unwrap());
    let proxy = ConnectInfo("127.0.0.1:4000".parse().unwrap());
    let public_peer = ConnectInfo("198.51.100.2:4000".parse().unwrap());

    assert_eq!(
        avatar_request_ip(&headers, Some(&proxy)),
        Some("203.0.113.8".parse().unwrap())
    );
    assert_eq!(
        avatar_request_ip(&headers, Some(&public_peer)),
        Some("198.51.100.2".parse().unwrap())
    );
}
