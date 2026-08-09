use super::*;

const VERSIONED_DMG_URL: &str =
    "https://kordi.ai/updates/releases/0.0.1-beta.12/Kordi_0.0.1-beta.12_aarch64.dmg";

#[test]
fn app_invite_tokens_are_opaque_and_hash_stably() {
    let first = new_app_invite_token();
    let second = new_app_invite_token();
    assert!(first.starts_with(APP_INVITE_TOKEN_PREFIX));
    assert_ne!(first, second);
    assert_eq!(hash_app_invite_token(&first), hash_app_invite_token(&first));
    assert_ne!(
        hash_app_invite_token(&first),
        hash_app_invite_token(&second)
    );
    assert!(!hash_app_invite_token(&first).contains(&first));
}

#[test]
fn invitation_landing_escapes_inviter_names() {
    assert_eq!(
        escape_html("<Shuyang & 'friends'>"),
        "&lt;Shuyang &amp; &#39;friends&#39;&gt;"
    );
}

#[test]
fn release_download_url_requires_a_versioned_kordi_dmg() {
    assert_eq!(
        safe_release_download_url(Some(VERSIONED_DMG_URL)).as_deref(),
        Some(VERSIONED_DMG_URL)
    );
    assert!(
        safe_release_download_url(Some("https://kordi.ai/updates/releases/latest/Kordi.dmg"))
            .is_none()
    );
    assert!(safe_release_download_url(Some(
        "https://example.com/updates/releases/0.0.1/Kordi.dmg"
    ))
    .is_none());
    assert!(
        safe_release_download_url(Some("http://kordi.ai/updates/releases/0.0.1/Kordi.dmg"))
            .is_none()
    );
}

#[test]
fn invitation_document_matches_the_approved_kordi_surface() {
    let document = invitation_landing_document(
        "Shu Yang invited you to Kordi.",
        "A shared workspace where people and agents work together.",
        Some(VERSIONED_DMG_URL),
    );

    assert!(document.contains("<span>kordi</span>"));
    assert!(document.contains(
        "<link rel=\"icon\" type=\"image/png\" sizes=\"512x512\" href=\"/assets/favicon.png\">"
    ));
    assert!(document.contains("Download Kordi for Mac"));
    assert!(document.contains(VERSIONED_DMG_URL));
    assert!(document.contains("href=\"https://kordi.ai/\">Learn more</a>"));
    assert!(document.contains("&copy; Kordi 2026"));
    assert!(!document.contains("Back to overview"));
    assert!(!document.contains("Kordi beta"));
    assert!(!document.contains("@218208141"));
    assert!(!document.contains("/updates/releases/latest/Kordi.dmg"));
}

#[test]
fn invitation_document_escapes_copy_and_degrades_without_a_release() {
    let document = invitation_landing_document(
        "<script>alert(1)</script>",
        "Try <again> & ask the sender.",
        Some("https://example.com/Kordi.dmg"),
    );

    assert!(document.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(document.contains("Try &lt;again&gt; &amp; ask the sender."));
    assert!(!document.contains("<script>alert(1)</script>"));
    assert!(!document.contains("Download Kordi for Mac"));
    assert!(
        document.contains("class=\"button button-primary\" href=\"https://kordi.ai/\">Learn more")
    );
}

#[test]
fn invitation_document_can_offer_a_safe_open_app_action() {
    let document = invitation_landing_document_with_open_action(
        "Join Product Team",
        "Preview and confirm inside Kordi.",
        Some(("Open Kordi", "kordi://group-invite/kordi_gi_token")),
        Some(VERSIONED_DMG_URL),
    );

    assert!(document.contains("Open Kordi"));
    assert!(document.contains("kordi://group-invite/kordi_gi_token"));
    assert!(document.contains("Download Kordi for Mac"));
}

#[test]
fn invitation_response_allows_the_same_origin_favicon() {
    let response = invitation_landing_html(
        StatusCode::OK,
        "Join Kordi",
        "Continue in the Kordi app.",
        None,
    );
    let policy = response
        .headers()
        .get("content-security-policy")
        .expect("invitation response should set a content security policy")
        .to_str()
        .expect("content security policy should be valid header text");

    assert!(policy.contains("img-src 'self'"));
}
