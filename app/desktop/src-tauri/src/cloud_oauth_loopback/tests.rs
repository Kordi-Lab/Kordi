mod completion_page_tests {
    use super::super::{completion_page_html, KORDI_FAVICON_DATA_URL};

    #[test]
    fn renders_kordi_wordmark_and_boots_in_loading_state() {
        let html = completion_page_html("cloud_oauth_abc123");

        // Page boots into the loading state via the data attribute on <html>,
        // so the success / error markup is pre-rendered but hidden until JS
        // toggles the attribute. That keeps the layout stable across states.
        assert!(
            html.contains("data-status=\"loading\""),
            "page should boot in loading state"
        );
        assert!(
            !html.contains("auth-label"),
            "page should not render a visible label chip"
        );

        assert!(html.contains("<span>kordi</span>"));
        assert!(html.contains("rel=\"icon\" type=\"image/svg+xml\""));
        assert!(html.contains(KORDI_FAVICON_DATA_URL));
        assert_eq!(html.matches("<circle ").count(), 3);
        assert!(html.contains("&copy; Kordi 2026"));
        assert!(!html.contains("state-marker"));

        // All three copy blocks are pre-rendered so the swap between them is
        // just an attribute flip, never a layout shift.
        for title in [
            "data-title-loading",
            "data-title-success",
            "data-title-error",
        ] {
            assert!(html.contains(title), "missing title state: {title}");
        }
        for sub in ["data-sub-loading", "data-sub-success", "data-sub-error"] {
            assert!(html.contains(sub), "missing subtitle state: {sub}");
        }
    }

    #[test]
    fn copy_matches_brand_voice_for_each_state() {
        let html = completion_page_html("cloud_oauth_abc123");

        assert!(!html.contains("KORDI LOGIN"));
        assert!(html.contains("Completing sign-in"));
        assert!(html.contains("Signed in"));
        assert!(html.contains("Couldn’t sign in"));
        assert!(html
            .contains("Your account is connected. You can close this window and return to Kordi."));
        assert!(html.contains("Finishing the secure browser handoff to Kordi."));
        assert!(html.contains("Return to Kordi and try signing in again."));
        assert!(!html.contains("Kordi is ready in the app"));
        assert!(!html.contains("This window will update automatically"));
        assert!(!html.contains("No account changes were made"));
        assert!(!html.contains("Close window"));
        assert!(!html.contains("<button"));
        assert!(
            !html.contains("Authentication Successful") && !html.contains("Login Successful"),
            "cloud login callback should use direct signed-in copy"
        );
        assert!(
            !html.contains("READY"),
            "status should not use the large repeated pill treatment"
        );
        assert!(
            !html.contains("Kordi sign-in complete"),
            "success title should not repeat the wordmark"
        );
    }

    #[test]
    fn script_posts_to_complete_endpoint_with_request_id() {
        let html = completion_page_html("cloud_oauth_xyz789");
        assert!(
            html.contains("/complete/cloud_oauth_xyz789"),
            "completion POST should target the request-specific endpoint"
        );
        assert!(
            html.contains("method: 'POST'"),
            "completion ping must be a POST so the loopback server flips status"
        );
    }

    #[test]
    fn page_carries_brand_palette_and_dark_mode_support() {
        let html = completion_page_html("cloud_oauth_palette");

        // The callback uses the same warm paper, ink, rules, and simple
        // header/content/footer structure as Kordi's public web surfaces.
        assert!(
            html.contains("--paper: #faf9f7"),
            "light mode should use the Kordi paper surface"
        );
        assert!(
            html.contains("--paper: #191814"),
            "dark mode should use the Kordi dark paper surface"
        );
        assert!(html.contains("grid-template-rows: auto 1fr auto"));
        assert!(html.contains("text-align: center"));
        assert!(
            html.contains("prefers-color-scheme: dark"),
            "dark mode must be supported"
        );
        assert!(!html.contains("linear-gradient"));
        assert!(!html.contains("filter: blur"));
        assert!(!html.contains("animation:"));
    }

    #[test]
    fn uses_self_contained_kordi_typography_and_scale() {
        let html = completion_page_html("cloud_oauth_font");

        assert!(
            html.contains("-apple-system, BlinkMacSystemFont"),
            "body copy should use the platform system stack"
        );
        assert!(
            html.contains("\"Iowan Old Style\", \"Palatino Linotype\", Palatino, Georgia, serif"),
            "display copy should use the self-contained Kordi serif stack"
        );
        assert!(
            !html.contains("text-transform: uppercase"),
            "callback label should not force the kordi wordmark into capitals"
        );
        assert!(
            html.contains("font-size: clamp(48px, 8vw, 72px);"),
            "callback title should use the approved Kordi display scale"
        );
        assert!(
            html.contains("font-size: 15px;"),
            "callback subtitle should use the shared compact callback scale"
        );
        assert!(
            !html.contains("Avenir Next"),
            "callback page should not use the previous display font"
        );
    }

    #[test]
    fn page_has_no_external_network_or_banned_design_patterns() {
        let html = completion_page_html("cloud_oauth_selfcontained");

        // The loopback server can't proxy external assets and we don't want
        // the callback page to phone home, so the page must be self-contained.
        for forbidden in ["fonts.googleapis", "fonts.gstatic", "cdn.", "https://"] {
            assert!(
                !html.contains(forbidden),
                "callback page must not reference external URL: {forbidden}"
            );
        }

        // Anti-slop checks: gradient-fill text and side-stripe borders are
        // bans from the Kordi design context (.impeccable.md).
        assert!(!html.contains("background-clip: text"));
        assert!(!html.contains("border-left: 4px"));
        assert!(!html.contains("border-left: 3px"));
        assert!(!html.contains("class=\"card\""));
        assert!(
            !html.contains("<path"),
            "the removed status icon must stay removed"
        );
    }
}

mod completion_page_preview {
    use super::super::completion_page_html;
    use std::fs;

    // Gated on KORDI_RENDER_OAUTH_CALLBACK to keep CI runs from writing files.
    // Run with: KORDI_RENDER_OAUTH_CALLBACK=1 cargo test -p kordi-desktop --lib completion_page_preview -- --nocapture
    #[test]
    fn render_to_tmp() {
        if std::env::var("KORDI_RENDER_OAUTH_CALLBACK").is_err() {
            return;
        }
        let html = completion_page_html("preview");
        let path = std::env::temp_dir().join("kordi-oauth-callback.html");
        fs::write(&path, &html).expect("write preview");
        println!("preview: {}", path.display());
    }
}
