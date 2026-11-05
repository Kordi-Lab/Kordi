//! Smoke check: the development Docker stack builds the server in release
//! mode, so its `cloud-server` environment must satisfy every release-only
//! startup requirement with nothing but the required `.env` values set.

use std::collections::HashMap;

use super::check_release_startup;
use crate::support::PendingSupportConfig;
use crate::system_agent::PendingSystemAgentConfig;

const COMPOSE: &str = include_str!("../../../../deploy/dev/compose.yaml");

/// Stands in for values `deploy/dev/.env` must provide (`${NAME:?...}`).
const REQUIRED_PLACEHOLDER: &str = "set-in-dev-env";

/// The `cloud-server` service environment, interpolated the way Compose
/// does against `host`.
fn cloud_server_environment(host: &HashMap<&str, &str>) -> HashMap<String, String> {
    let mut lines = COMPOSE.lines();
    lines
        .by_ref()
        .find(|line| *line == "  cloud-server:")
        .expect("cloud-server service");
    lines
        .by_ref()
        .find(|line| *line == "    environment:")
        .expect("cloud-server environment");
    let mut environment = HashMap::new();
    for line in lines {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.len() - trimmed.len() < 6 {
            break;
        }
        let (key, value) = trimmed.split_once(':').expect("KEY: value");
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        environment.insert(key.to_string(), interpolate(value, host));
    }
    environment
}

fn interpolate(value: &str, host: &HashMap<&str, &str>) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = closing_brace(after);
        out.push_str(&expand(&after[..end], host));
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn closing_brace(text: &str) -> usize {
    let mut depth = 0;
    for (index, byte) in text.bytes().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' if depth == 0 => return index,
            b'}' => depth -= 1,
            _ => {}
        }
    }
    panic!("unclosed interpolation in {text}");
}

fn expand(expression: &str, host: &HashMap<&str, &str>) -> String {
    let name_end = expression
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(expression.len());
    let (name, operator) = expression.split_at(name_end);
    let value = host.get(name).copied().filter(|value| !value.is_empty());
    match operator.get(..2) {
        Some(":-") => value.map_or_else(|| interpolate(&operator[2..], host), str::to_string),
        Some(":+") => value.map_or_else(String::new, |_| interpolate(&operator[2..], host)),
        Some(":?") => value.unwrap_or(REQUIRED_PLACEHOLDER).to_string(),
        _ => value.unwrap_or_default().to_string(),
    }
}

fn lookup(environment: &HashMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
    |key| environment.get(key).cloned()
}

#[test]
fn dev_compose_meets_release_startup_requirements() {
    let environment = cloud_server_environment(&HashMap::new());
    check_release_startup(lookup(&environment)).unwrap();
    assert_eq!(
        environment["KORDI_CLOUD_PUBLIC_BASE_URL"],
        "http://127.0.0.1:17081"
    );
    assert_eq!(environment["KORDI_CLIENT_CALLBACK_SCHEME"], "kordi-beta");
    // Without web pages configured, the server sees an empty setting.
    assert_eq!(environment["KORDI_WEB_PAGES_DIR"], "");
    // Agents with release-only requirements stay off by default.
    assert!(matches!(
        PendingSystemAgentConfig::from_lookup(lookup(&environment)),
        Ok(None)
    ));
    assert!(matches!(
        PendingSupportConfig::from_lookup(lookup(&environment)),
        Ok(None)
    ));
}

#[test]
fn dev_compose_overrides_still_meet_release_requirements() {
    let host = HashMap::from([
        ("KORDI_DEBUG_PUBLIC_API_PORT", "18081"),
        ("KORDI_CLIENT_CALLBACK_SCHEME", "kordi-staging"),
        ("KORDI_DEBUG_WEB_PAGES_DIR", "/srv/example-pages"),
    ]);
    let environment = cloud_server_environment(&host);
    check_release_startup(lookup(&environment)).unwrap();
    assert_eq!(
        environment["KORDI_CLOUD_PUBLIC_BASE_URL"],
        "http://127.0.0.1:18081"
    );
    assert_eq!(environment["KORDI_CLIENT_CALLBACK_SCHEME"], "kordi-staging");
    assert_eq!(environment["KORDI_WEB_PAGES_DIR"], "/srv/kordi-web-pages");
}

#[test]
fn dev_compose_forwards_release_system_agent_settings() {
    // A release build has no defaults for these, so a development .env that
    // turns the System agent on must be able to set every one of them.
    let environment = cloud_server_environment(&HashMap::new());
    for key in [
        "KORDI_SYSTEM_AGENT_ENABLED",
        "KORDI_SYSTEM_AGENT_OPENAI_API_KEY",
        "KORDI_SYSTEM_AGENT_OPENAI_MODEL",
        "KORDI_SYSTEM_AGENT_AGENT_NAME",
        "KORDI_SYSTEM_AGENT_AGENT_SUBTITLE",
        "KORDI_SYSTEM_AGENT_OWNER_EMAIL",
        "KORDI_SYSTEM_AGENT_PERSONA",
    ] {
        assert!(environment.contains_key(key), "{key} is not forwarded");
    }
}

#[test]
fn interpolation_follows_compose_rules() {
    let host = HashMap::from([("SET", "value"), ("EMPTY", "")]);
    assert_eq!(interpolate("${SET:-fallback}", &host), "value");
    assert_eq!(interpolate("${EMPTY:-fallback}", &host), "fallback");
    assert_eq!(interpolate("${MISSING:-${SET:-x}}", &host), "value");
    assert_eq!(interpolate("${SET:+alt}", &host), "alt");
    assert_eq!(interpolate("${MISSING:+alt}", &host), "");
    assert_eq!(
        interpolate("${MISSING:?message}", &host),
        REQUIRED_PLACEHOLDER
    );
    assert_eq!(interpolate("a:${SET}/b", &host), "a:value/b");
}
