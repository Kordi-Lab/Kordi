use super::landing::{landing_document, landing_response, LandingView, SIGN_IN_RETURN_PARAM};
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
}

#[test]
fn signed_in_page_claims_only_through_a_form_with_the_csrf_token() {
    let page = landing_document(&LandingView::SignedIn {
        group: "Reading group".to_string(),
        viewer: Some("Ana Silva".to_string()),
        token: TOKEN.to_string(),
        csrf: "csrf-value".to_string(),
        download_url: Some("https://example.test/download.dmg".to_string()),
    });
    assert!(page.contains("Open Kordi to join"));
    assert!(page.contains("Reading group is waiting in the app."));
    assert!(page.contains(&format!(r#"method="post" action="/g/{TOKEN}""#)));
    assert!(page.contains(r#"name="csrf" value="csrf-value""#));
    assert!(page.contains(r#"type="submit">Open Kordi</button>"#));
    assert!(page.contains("Download for Mac"));
    assert!(page.contains(">AS</span><span>Ana Silva</span>"));
    assert!(!page.contains("Sign up"));
    assert!(!page.contains("<script"));
}

#[test]
fn member_page_opens_the_app() {
    let page = landing_document(&LandingView::Member {
        group: "Reading group".to_string(),
        token: TOKEN.to_string(),
    });
    assert!(page.contains("You&#39;re in Reading group"));
    assert!(page.contains(&format!(
        "href=\"{}\">Open the app</a>",
        group_invite_deep_link(TOKEN)
    )));
    assert!(!page.contains("<form"));
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
