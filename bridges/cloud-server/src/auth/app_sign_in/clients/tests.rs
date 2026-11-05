use super::*;

#[test]
fn builtin_clients_have_their_own_callbacks() {
    let registry = AppClientRegistry::builtin();
    let ios = registry.client("kordi-ios").unwrap();
    assert!(ios.allows_redirect_uri("kordi://auth/callback"));
    assert!(!ios.allows_redirect_uri("kordi-beta://auth/callback"));
    let beta = registry.client("kordi-ios-beta").unwrap();
    assert!(beta.allows_redirect_uri("kordi-beta://auth/callback"));
    assert!(!beta.allows_redirect_uri("kordi://auth/callback"));
    let staging = registry.client("kordi-desktop-staging").unwrap();
    assert!(staging.allows_redirect_uri("kordi-staging://auth/callback"));
    assert!(staging.allows_redirect_uri("http://127.0.0.1:51234/auth/callback"));
    assert!(registry.client("unknown").is_none());
    assert!(registry.client("KORDI-IOS").is_none());
}

#[test]
fn loopback_redirects_accept_any_port_but_nothing_else() {
    let desktop = AppClientRegistry::builtin()
        .client("kordi-desktop")
        .unwrap()
        .clone();
    for allowed in [
        "http://127.0.0.1:51234/auth/callback",
        "http://127.0.0.1:1/auth/callback",
        "http://[::1]:8080/auth/callback",
        "kordi://auth/callback",
    ] {
        assert!(desktop.allows_redirect_uri(allowed), "{allowed}");
    }
    for rejected in [
        // A different path, query, host, or scheme.
        "http://127.0.0.1:51234/auth/callback/extra",
        "http://127.0.0.1:51234/auth/callback?next=1",
        "http://127.0.0.1:51234/auth/callback#fragment",
        "http://127.0.0.1:51234/auth/../auth/callback",
        "http://127.0.0.1:51234/AUTH/callback",
        "http://localhost:51234/auth/callback",
        "http://127.0.0.2:51234/auth/callback",
        "https://127.0.0.1:51234/auth/callback",
        "http://user@127.0.0.1:51234/auth/callback",
        "http://127.0.0.1.example.test:51234/auth/callback",
        // A port is required, and port 0 is not a listener.
        "http://127.0.0.1/auth/callback?x",
        "http://127.0.0.1:0/auth/callback",
        // Custom schemes match exactly.
        "kordi://auth/callback/",
        "kordi://auth/callback?x=1",
        "kordi://evil.example.test/auth/callback",
        "",
    ] {
        assert!(!desktop.allows_redirect_uri(rejected), "{rejected}");
    }
    // The registered portless loopback URI itself is an exact match.
    assert!(desktop.allows_redirect_uri("http://127.0.0.1/auth/callback"));
}

#[test]
fn ios_clients_accept_only_their_exact_custom_scheme_callback() {
    let registry = AppClientRegistry::builtin();
    for (client_id, scheme) in [
        ("kordi-ios", "kordi"),
        ("kordi-ios-beta", "kordi-beta"),
        ("kordi-ios-staging", "kordi-staging"),
    ] {
        let client = registry.client(client_id).unwrap();
        let callback = format!("{scheme}://auth/callback");
        // The iPhone app has no loopback listener: one redirect URI only.
        assert_eq!(client.redirect_uris, vec![callback.clone()], "{client_id}");
        assert!(client.allows_redirect_uri(&callback), "{client_id}");
        for rejected in [
            format!("{scheme}://auth/callback/"),
            format!("{scheme}://auth/callback?next=1"),
            format!("{scheme}://auth/callback#fragment"),
            format!("{scheme}://oauth/callback"),
            format!("{scheme}://evil.example.test/auth/callback"),
            format!("{}://auth/callback", scheme.to_uppercase()),
            format!("{scheme}x://auth/callback"),
            "http://127.0.0.1:51234/auth/callback".to_string(),
            "http://127.0.0.1/auth/callback".to_string(),
            "https://kordi.ai/auth/callback".to_string(),
        ] {
            assert!(
                !client.allows_redirect_uri(&rejected),
                "{client_id}: {rejected}"
            );
        }
    }
}

#[test]
fn ports_in_a_loopback_registration_are_exact() {
    assert!(redirect_uri_matches(
        "http://127.0.0.1:7000/cb",
        "http://127.0.0.1:7000/cb"
    ));
    assert!(!redirect_uri_matches(
        "http://127.0.0.1:7000/cb",
        "http://127.0.0.1:7001/cb"
    ));
}

#[test]
fn configured_clients_replace_the_builtin_list() {
    let registry = AppClientRegistry::from_json(
        r#"[{"clientId":"example-app","name":"Example","redirectUris":["example-app://auth/callback","https://app.example.test/callback"]}]"#,
    )
    .unwrap();
    let client = registry.client("example-app").unwrap();
    assert!(client.allows_redirect_uri("example-app://auth/callback"));
    assert!(client.allows_redirect_uri("https://app.example.test/callback"));
    assert!(!client.allows_redirect_uri("https://app.example.test/callback/"));
    assert!(registry.client("kordi-desktop").is_none());
}

#[test]
fn invalid_client_configuration_is_rejected() {
    for invalid in [
        "not json",
        r#"[{"clientId":"","name":"x","redirectUris":["x-app://cb"]}]"#,
        r#"[{"clientId":" a","name":"x","redirectUris":["x-app://cb"]}]"#,
        r#"[{"clientId":"a","name":"x","redirectUris":[]}]"#,
        r#"[{"clientId":"a","name":"x","redirectUris":["http://app.example.test/cb"]}]"#,
        r#"[{"clientId":"a","name":"x","redirectUris":["x-app://cb#frag"]}]"#,
        r#"[{"clientId":"a","name":"x","redirectUris":["relative/path"]}]"#,
        r#"[{"clientId":"a","name":"x","redirectUris":["x-app://cb"]},{"clientId":"a","name":"y","redirectUris":["y-app://cb"]}]"#,
    ] {
        assert!(AppClientRegistry::from_json(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn browser_handled_schemes_cannot_be_callbacks() {
    for uri in [
        "javascript:alert(1)",
        "JavaScript://cb/%0aalert(1)",
        "data:text/html,x",
        "file:///tmp/cb",
        "blob:https://app.example.test/x",
        "vbscript:msgbox",
        "about:blank",
    ] {
        let config = serde_json::json!([{ "clientId": "a", "name": "x", "redirectUris": [uri] }]);
        assert!(
            AppClientRegistry::from_json(&config.to_string()).is_err(),
            "{uri}"
        );
    }
}
