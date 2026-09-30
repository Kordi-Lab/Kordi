use std::collections::HashMap;

fn csp_directives() -> HashMap<String, Vec<String>> {
    let context: tauri::Context<tauri::test::MockRuntime> = tauri::generate_context!();
    let csp = context
        .config()
        .app
        .security
        .csp
        .clone()
        .expect("the desktop webview must ship a Content-Security-Policy");
    csp.to_string()
        .split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty())
        .map(|directive| {
            let mut parts = directive.split_whitespace().map(str::to_string);
            let name = parts.next().expect("directive name");
            (name, parts.collect())
        })
        .collect()
}

fn sources<'a>(directives: &'a HashMap<String, Vec<String>>, name: &str) -> &'a [String] {
    directives
        .get(name)
        .unwrap_or_else(|| panic!("missing {name} directive"))
}

#[test]
fn scripts_load_only_from_the_app_bundle() {
    let directives = csp_directives();
    assert_eq!(sources(&directives, "default-src"), ["'self'"]);
    assert_eq!(sources(&directives, "script-src"), ["'self'"]);
    assert_eq!(sources(&directives, "object-src"), ["'none'"]);
    assert_eq!(sources(&directives, "base-uri"), ["'self'"]);
    assert_eq!(sources(&directives, "frame-ancestors"), ["'none'"]);
    for (name, values) in &directives {
        for value in values {
            assert_ne!(value, "'unsafe-eval'", "{name} must not allow eval");
            assert_ne!(value, "*", "{name} must not allow every origin");
            if name != "style-src" {
                assert_ne!(
                    value, "'unsafe-inline'",
                    "{name} must not allow inline code"
                );
            }
        }
    }
    // Only the calendar import worker is created from a blob.
    assert_eq!(sources(&directives, "worker-src"), ["'self'", "blob:"]);
}

#[test]
fn network_access_covers_the_product_api_ipc_and_local_media() {
    let directives = csp_directives();
    let connect = sources(&directives, "connect-src");
    for required in [
        "'self'",
        "ipc:",
        "http://ipc.localhost",
        "asset:",
        "http://asset.localhost",
        "https://kordi.ai",
        "wss://kordi.ai",
    ] {
        assert!(
            connect.iter().any(|value| value == required),
            "connect-src needs {required}"
        );
    }
    assert!(
        !connect
            .iter()
            .any(|value| value == "https:" || value == "http:"),
        "webview requests must not reach arbitrary web origins"
    );
    for directive in ["img-src", "media-src"] {
        let values = sources(&directives, directive);
        for required in ["asset:", "http://asset.localhost", "blob:", "data:"] {
            assert!(
                values.iter().any(|value| value == required),
                "{directive} needs {required}"
            );
        }
    }
}

#[test]
fn loopback_origins_match_the_http_capability() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("default capability");
    let loopback_origins: Vec<String> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|permission| permission["identifier"] == "http:default")
        .expect("http permission")["allow"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|scope| scope["url"].as_str())
        .filter(|url| url.starts_with("http://127.0.0.1:"))
        .map(str::to_string)
        .collect();
    assert!(!loopback_origins.is_empty());

    let directives = csp_directives();
    let connect = sources(&directives, "connect-src");
    for origin in &loopback_origins {
        let websocket = origin.replacen("http://", "ws://", 1);
        assert!(connect.contains(origin), "connect-src needs {origin}");
        assert!(
            connect.contains(&websocket),
            "connect-src needs {websocket}"
        );
    }
    for value in connect.iter().filter(|value| value.contains("127.0.0.1")) {
        let http_origin = value.replacen("ws://", "http://", 1);
        assert!(
            loopback_origins.contains(&http_origin),
            "{value} is not an allowed development API origin"
        );
    }
}

#[test]
fn inline_styles_keep_working_under_the_policy() {
    // Tauri adds a nonce to style-src for inline <style> elements in the HTML
    // entry point, which would make browsers ignore 'unsafe-inline' and break
    // styles that libraries inject at runtime.
    let directives = csp_directives();
    assert_eq!(
        sources(&directives, "style-src"),
        ["'self'", "'unsafe-inline'"]
    );
    let index = include_str!("../../index.html").to_ascii_lowercase();
    assert!(
        !index.contains("<style"),
        "keep inline <style> elements out of index.html"
    );
}

#[test]
fn edition_configs_do_not_relax_the_policy() {
    for (name, source) in [
        (
            "tauri.cloud.conf.json",
            include_str!("../tauri.cloud.conf.json"),
        ),
        (
            "tauri.cloud.acceptance.conf.json",
            include_str!("../tauri.cloud.acceptance.conf.json"),
        ),
        (
            "tauri.cloud.acceptance-bootstrap.conf.json",
            include_str!("../tauri.cloud.acceptance-bootstrap.conf.json"),
        ),
    ] {
        let config: serde_json::Value = serde_json::from_str(source).expect(name);
        assert!(
            config.pointer("/app/security").is_none(),
            "{name} must inherit the base security settings"
        );
    }
}
