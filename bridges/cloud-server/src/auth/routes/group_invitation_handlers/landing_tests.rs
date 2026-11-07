use super::landing::{
    claim_redirect_target, landing_document, landing_response, LandingView, SIGN_IN_RETURN_PARAM,
};
use super::*;

const TOKEN: &str = "kordi_gi_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[test]
fn signed_out_page_names_inviter_group_and_count_and_returns_after_sign_in() {
    let page = landing_document(&LandingView::SignedOut {
        inviter: "Maya <Chen>".to_string(),
        group: "Reading group".to_string(),
        member_count: 3,
        token: TOKEN.to_string(),
    });
    assert!(page.contains("Maya &lt;Chen&gt; invited you to Reading group"));
    assert!(!page.contains("<Chen>"));
    assert!(page.contains("3 members on Kordi"));
    assert!(page.contains(&format!(
        r#"href="/register?{SIGN_IN_RETURN_PARAM}=%2Fg%2F{TOKEN}">Sign up</a>"#
    )));
    assert!(page.contains(&format!(
        r#"href="/login?{SIGN_IN_RETURN_PARAM}=%2Fg%2F{TOKEN}">Log in</a>"#
    )));
    assert!(page.contains(&format!(
        "Have Kordi? <a href=\"{}\">Open the app</a>",
        group_invite_deep_link(TOKEN)
    )));
    assert!(!page.contains("<form"));
    assert!(!page.contains("<script"));
    // The kordi.ai home page's type, header and footer.
    assert!(page.contains("/research-preview/public/assets/fonts/geist-600.ttf"));
    assert!(page.contains(r#"<header class="wrap mast">"#));
    assert!(page.contains(r#"<nav aria-label="Footer">"#));
    assert!(!page.contains("Marcellus"));
    // The card's actions, then the header's, return to this invitation.
    let card = page.find(r#"<section class="x-auth-card">"#).unwrap();
    let card_sign_up = page.find(r#"class="button button-primary""#).unwrap();
    assert!(card < card_sign_up);
    assert!(page.contains(&format!(
        r#"<a class="nav-login" href="/login?{SIGN_IN_RETURN_PARAM}=%2Fg%2F{TOKEN}">Log in</a>"#
    )));
    assert!(page.contains(&format!(
        r#"<a class="nav-signup" href="/register?{SIGN_IN_RETURN_PARAM}=%2Fg%2F{TOKEN}">Sign up</a>"#
    )));
}

fn every_view() -> Vec<LandingView> {
    vec![
        LandingView::SignedOut {
            inviter: "Maya Chen".to_string(),
            group: "Reading group".to_string(),
            member_count: 1,
            token: TOKEN.to_string(),
        },
        LandingView::SignedIn {
            group: "Reading group".to_string(),
            viewer: None,
            token: TOKEN.to_string(),
            csrf: "csrf-value".to_string(),
            download_url: None,
            web: true,
        },
        LandingView::Member {
            group: "Reading group".to_string(),
            token: TOKEN.to_string(),
            web: false,
        },
        LandingView::Expired,
        LandingView::TooManyPending {
            token: TOKEN.to_string(),
            web: false,
        },
        LandingView::Retry {
            token: TOKEN.to_string(),
        },
        LandingView::Unavailable,
    ]
}

#[test]
fn every_state_uses_the_sign_in_layout_with_the_home_page_lines() {
    for view in every_view() {
        let page = landing_document(&view);
        assert!(page.contains(r#"<body class="interior-page x-auth-page">"#));
        assert!(page.contains(r#"<main id="main" class="x-story">"#));
        assert!(page.contains(
            r#"<p class="x-story-headline">Build the next <span>supercollaboration.</span></p>"#
        ));
        assert!(page.contains(
            "Every communication in one place, with AI that is proactive and cooperative."
        ));
        // The invitation sits in the card, after the story copy.
        let copy = page.find(r#"class="x-story-copy""#).unwrap();
        let card = page.find(r#"<section class="x-auth-card">"#).unwrap();
        let heading = page.find("<h1>").unwrap();
        assert!(copy < card && card < heading);
        assert!(page.contains(r#"<div class="x-story-reel" aria-hidden="true" inert>"#));
        assert!(page.contains(r#"<a href="https://github.com/Kordi-AI/Kordi">GitHub</a>"#));
        assert!(!page.contains("<script"));
        // Only signed-out visitors get the header's account links.
        assert_eq!(
            page.contains(r#"class="nav-login""#),
            matches!(view, LandingView::SignedOut { .. })
        );
    }
}

#[test]
fn signed_in_page_claims_only_through_a_form_with_the_csrf_token() {
    let page = landing_document(&LandingView::SignedIn {
        group: "Reading group".to_string(),
        viewer: Some("Ana Silva".to_string()),
        token: TOKEN.to_string(),
        csrf: "csrf-value".to_string(),
        download_url: Some("https://example.test/download.dmg".to_string()),
        web: false,
    });
    assert!(page.contains("Open Kordi to join"));
    assert!(page.contains("Reading group is waiting in the app."));
    assert!(page.contains(&format!(r#"method="post" action="/g/{TOKEN}""#)));
    assert!(page.contains(r#"name="csrf" value="csrf-value""#));
    assert!(page.contains(r#"name="continue" value="app">Open Kordi</button>"#));
    assert!(!page.contains("Continue on the web"));
    assert!(page.contains("Download for Mac"));
    assert!(page.contains(">AS</span><span>Ana Silva</span>"));
    assert!(!page.contains("Sign up"));
    assert!(!page.contains("<script"));
}

#[test]
fn signed_in_page_offers_the_app_and_the_web_from_one_claim_form() {
    let page = landing_document(&LandingView::SignedIn {
        group: "Reading <group>".to_string(),
        viewer: Some("Ana Silva".to_string()),
        token: TOKEN.to_string(),
        csrf: "csrf-value".to_string(),
        download_url: None,
        web: true,
    });
    assert!(page.contains("<h1>Join Reading &lt;group&gt;</h1>"));
    assert!(page.contains("Open it in the app or on the web."));
    assert_eq!(page.matches("<form").count(), 1);
    assert!(page.contains(&format!(r#"method="post" action="/g/{TOKEN}""#)));
    assert!(page.contains(r#"name="csrf" value="csrf-value""#));
    let open = page
        .find(r#"<button class="button button-primary" type="submit" name="continue" value="app">Open Kordi</button>"#)
        .expect("primary Open Kordi");
    let web = page
        .find(r#"<button class="button button-secondary" type="submit" name="continue" value="web">Continue on the web</button>"#)
        .expect("secondary Continue on the web");
    assert!(open < web);
    assert!(!page.contains("Download for Mac"));
    assert!(!page.contains("<script"));
}

#[test]
fn claims_continue_only_to_the_web_app_or_the_deep_link() {
    assert_eq!(claim_redirect_target(TOKEN, true), "/app/");
    assert_eq!(
        claim_redirect_target(TOKEN, false),
        group_invite_deep_link(TOKEN)
    );
    assert!(group_invite_deep_link(TOKEN).starts_with(&format!(
        "{}://group-invite/",
        crate::distribution::callback_scheme()
    )));
}

#[test]
fn member_page_opens_the_app() {
    for web in [false, true] {
        let page = landing_document(&LandingView::Member {
            group: "Reading group".to_string(),
            token: TOKEN.to_string(),
            web,
        });
        assert!(page.contains("You&#39;re in Reading group"));
        assert!(page.contains(&format!(
            "href=\"{}\">Open the app</a>",
            group_invite_deep_link(TOKEN)
        )));
        assert_eq!(
            page.contains(r#"href="/app/">Continue on the web</a>"#),
            web
        );
        assert!(!page.contains("<form"));
    }
}

#[test]
fn expired_page_does_not_name_the_inviter_or_group() {
    let page = landing_document(&LandingView::Expired);
    assert!(page.contains("This link expired"));
    assert!(page.contains("Ask the sender for a new one."));
    assert!(!page.contains("invited you"));
    assert!(!page.contains("group-invite/"));
    assert!(!page.contains("<form"));
}

#[test]
fn landing_response_allows_the_form_and_the_app_redirect_only() {
    let response = landing_response(StatusCode::OK, &LandingView::Expired);
    let headers = response.headers();
    let csp = headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("default-src 'none'"));
    assert!(csp.contains(&format!(
        "form-action 'self' {}:;",
        crate::distribution::callback_scheme()
    )));
    assert!(!csp.contains("script-src"));
    assert_eq!(headers.get("referrer-policy").unwrap(), "same-origin");
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
}
