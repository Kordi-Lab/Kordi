use super::{clean_required_signup_avatar_url, oauth_account_avatar_url};
use axum::http::StatusCode;

#[test]
fn signup_avatar_requires_uploaded_image_not_seed() {
    let missing =
        clean_required_signup_avatar_url(None).expect_err("missing avatar should be rejected");
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

    let seeded = clean_required_signup_avatar_url(Some("kordi-pixel-avatar://cloud-signup:abc"))
        .expect_err("generated avatars should be rejected");
    assert_eq!(seeded.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn signup_avatar_accepts_small_png_jpeg_or_webp_data_urls() {
    for prefix in [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ] {
        let value = format!("{}AAAA", prefix);
        assert_eq!(
            clean_required_signup_avatar_url(Some(&value)).unwrap(),
            value
        );
    }
}

#[test]
fn oauth_provider_avatar_replaces_generated_signup_avatar() {
    assert_eq!(
        oauth_account_avatar_url(
            Some("kordi-pixel-avatar://cloud-signup:stable"),
            Some("https://avatars.example/provider.png"),
        ),
        Some("https://avatars.example/provider.png".to_string()),
    );
}

#[test]
fn oauth_provider_avatar_preserves_custom_uploaded_avatar() {
    assert_eq!(
        oauth_account_avatar_url(
            Some("data:image/png;base64,custom"),
            Some("https://avatars.example/provider.png"),
        ),
        Some("data:image/png;base64,custom".to_string()),
    );
}

#[test]
fn oauth_provider_avatar_refreshes_existing_provider_avatar() {
    assert_eq!(
        oauth_account_avatar_url(
            Some("https://avatars.example/old-provider.png"),
            Some("https://avatars.example/new-provider.png"),
        ),
        Some("https://avatars.example/new-provider.png".to_string()),
    );
}
