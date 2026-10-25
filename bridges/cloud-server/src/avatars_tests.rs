use super::rendering::{rasterize_svg, render_png};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

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
fn uploaded_asset_marker_round_trips_and_is_a_valid_mutation_value() {
    let asset_id = "ava_0123456789abcdef0123456789abcdef";
    let marker = assets::uploaded_avatar_marker(asset_id).expect("uploaded marker");
    assert_eq!(
        assets::parse_uploaded_avatar_marker(&marker),
        Some(assets::UploadedAvatarMarker {
            asset_id: asset_id.to_string(),
        })
    );
    assert_eq!(clean_uploaded_avatar(Some(&marker)), Ok(Some(marker)));
}

#[test]
fn uploaded_avatar_normalization_is_bounded_and_generates_all_variants() {
    let bytes = STANDARD
        .decode(ONE_PIXEL_PNG.split_once(',').unwrap().1)
        .expect("decode fixture");
    let normalized = assets::normalize_avatar(&bytes).expect("normalize avatar");

    assert_eq!(normalized.source_content_type, "image/png");
    assert_eq!(normalized.source_width, 1);
    assert_eq!(normalized.source_height, 1);
    assert_eq!(
        normalized
            .variants
            .iter()
            .map(|(size, _)| *size)
            .collect::<Vec<_>>(),
        assets::AVATAR_VARIANT_SIZES
    );
    assert!(normalized
        .variants
        .iter()
        .all(|(_, bytes)| bytes.starts_with(b"\xff\xd8\xff")));

    assert!(matches!(
        assets::normalize_avatar(&vec![0; assets::AVATAR_SOURCE_MAX_BYTES + 1]),
        Err(assets::AvatarAssetError::Invalid(
            "Avatar source exceeds 2 MiB."
        ))
    ));
}

#[test]
fn renderer_is_deterministic_for_every_pinned_style() {
    for style in [HUMAN_AVATAR_STYLE, AGENT_AVATAR_STYLE, BIRD_AVATAR_STYLE] {
        let first = render_png(style, "stable_seed").expect("render avatar");
        let second = render_png(style, "stable_seed").expect("render avatar again");
        assert_eq!(first, second);
        assert!(first.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}

#[tokio::test]
async fn preview_route_renders_every_style_as_png() {
    for style in [HUMAN_AVATAR_STYLE, AGENT_AVATAR_STYLE, BIRD_AVATAR_STYLE] {
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

async fn preview_png(style: &str, seed: &str) -> Vec<u8> {
    let response = render_avatar_preview(
        Extension(Arc::new(CloudRateLimiter::memory(
            CloudRateLimitConfig::production(),
        ))),
        None,
        HeaderMap::new(),
        Path((style.to_string(), format!("{seed}.png"))),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK, "{style}/{seed}");
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read rendered avatar")
        .to_vec()
}

#[tokio::test]
async fn untouched_agents_render_as_the_bird_their_seed_hashes_to() {
    // A default agent nobody changed stores `thumbs` with `default-agent-<account>`; the
    // shared fixtures pin this seed to the coral eagle, as the desktop and iOS hash it.
    let seed = "default-agent-acct_123";
    let bird = birds::parse_bird_seed(seed);
    assert_eq!(
        (bird.species, bird.tone, bird.palette),
        ("eagle", "color", "coral")
    );
    let expected = rasterize_svg(&birds::render_svg("bird-eagle-color-coral")).expect("eagle");
    assert_eq!(render_png(AGENT_AVATAR_STYLE, seed).unwrap(), expected);
    assert_eq!(
        render_png(BIRD_AVATAR_STYLE, "bird-eagle-color-coral").unwrap(),
        expected
    );
    // The legacy preview, the bird preview the desktop maps a `thumbs` marker to, and the
    // picked bird's own preview are one image.
    for (style, seed) in [
        (AGENT_AVATAR_STYLE, seed),
        (BIRD_AVATAR_STYLE, seed),
        (BIRD_AVATAR_STYLE, "bird-eagle-color-coral"),
    ] {
        assert_eq!(preview_png(style, seed).await, expected, "{style}/{seed}");
    }
}

#[tokio::test]
async fn people_keep_their_lorelei_avatars() {
    let seed = "acct_123";
    let style = dicebear_core::Style::from_str(dicebear_styles::get(HUMAN_AVATAR_STYLE).unwrap())
        .expect("lorelei style");
    let avatar = dicebear_core::Avatar::new(&style, json!({ "seed": seed, "size": 256 }))
        .expect("lorelei avatar");
    let expected = rasterize_svg(avatar.to_svg()).expect("lorelei");
    assert_eq!(render_png(HUMAN_AVATAR_STYLE, seed).unwrap(), expected);
    assert_eq!(preview_png(HUMAN_AVATAR_STYLE, seed).await, expected);
    assert_ne!(render_png(AGENT_AVATAR_STYLE, seed).unwrap(), expected);
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

fn regenerate(current_style: &str, entity_type: &str, seed: &str) -> AvatarDescriptor {
    let current = AvatarDescriptor {
        entity_type: entity_type.to_string(),
        entity_id: "entity_123".to_string(),
        source: "generated".to_string(),
        style: current_style.to_string(),
        seed: "stable_seed".to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 2,
        updated_at: "before".to_string(),
    };
    apply_avatar_mutation(
        &current,
        &AvatarMutationRequest {
            action: "regenerate".to_string(),
            uploaded_asset: None,
            seed: Some(seed.to_string()),
            expected_version: Some(2),
        },
        "after",
    )
    .expect("regenerate avatar")
}

#[test]
fn bird_seeds_switch_agents_to_the_bird_style() {
    let next = regenerate(AGENT_AVATAR_STYLE, "agent", "bird-osprey-color-sky");
    assert_eq!(next.style, BIRD_AVATAR_STYLE);
    assert_eq!(
        next.image_url(),
        generated_avatar_marker(BIRD_AVATAR_STYLE, "bird-osprey-color-sky", 3)
    );
    assert_eq!(
        regenerate(AGENT_AVATAR_STYLE, "agent", "3f9a1c2e4b5d6f70").style,
        AGENT_AVATAR_STYLE
    );
    assert_eq!(
        regenerate(BIRD_AVATAR_STYLE, "agent", "3f9a1c2e4b5d6f70").style,
        BIRD_AVATAR_STYLE
    );
    assert_eq!(
        regenerate(HUMAN_AVATAR_STYLE, "human", "bird-owl-ink-paper").style,
        HUMAN_AVATAR_STYLE
    );
}

#[test]
fn bird_markers_round_trip() {
    let marker = generated_avatar_marker(BIRD_AVATAR_STYLE, "bird-jay-mint", 4);
    assert_eq!(
        parse_generated_avatar_marker(&marker).map(|parsed| parsed.style),
        Some(BIRD_AVATAR_STYLE.to_string())
    );
    assert!(parse_generated_avatar_marker(&generated_avatar_marker("other", "seed", 1)).is_none());
}
