use base64::Engine as _;

use crate::client_config::ClientConfig;
use crate::identity;

mod doctor;
mod identity_commands;
mod projects;
mod setup;

pub use doctor::cmd_doctor;
pub(crate) use identity_commands::fetch_remote_identity_status;
pub use identity_commands::{
    cmd_identity_revoke, cmd_identity_rotate, cmd_identity_status, cmd_register,
};
pub use projects::{cmd_create, cmd_invite, cmd_join, cmd_members};
pub use setup::cmd_setup;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AddressableMember {
    node_id: String,
    display_name: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DoctorLevel {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DoctorCheck {
    name: &'static str,
    level: DoctorLevel,
    summary: String,
    hints: Vec<String>,
}

impl DoctorCheck {
    fn ok(name: &'static str, summary: impl Into<String>) -> Self {
        Self {
            name,
            level: DoctorLevel::Ok,
            summary: summary.into(),
            hints: Vec::new(),
        }
    }

    fn warn(name: &'static str, summary: impl Into<String>, hints: Vec<String>) -> Self {
        Self {
            name,
            level: DoctorLevel::Warn,
            summary: summary.into(),
            hints,
        }
    }

    fn error(name: &'static str, summary: impl Into<String>, hints: Vec<String>) -> Self {
        Self {
            name,
            level: DoctorLevel::Error,
            summary: summary.into(),
            hints,
        }
    }
}

fn print_check(check: &DoctorCheck) {
    let label = match check.level {
        DoctorLevel::Ok => "OK",
        DoctorLevel::Warn => "WARN",
        DoctorLevel::Error => "ERR",
    };
    println!("[{}] {} — {}", label, check.name, check.summary);
    for hint in &check.hints {
        println!("      hint: {}", hint);
    }
}

fn load_identity_or_exit() -> (ed25519_dalek::SigningKey, ed25519_dalek::VerifyingKey) {
    identity::load_or_create_keypair().unwrap_or_else(|err| {
        eprintln!("Failed to load identity: {}", err);
        std::process::exit(1);
    })
}

fn open_local_db_or_exit() -> rusqlite::Connection {
    let conn = crate::db::open_db().unwrap_or_else(|err| {
        eprintln!("Failed to open local database: {}", err);
        std::process::exit(1);
    });
    crate::db::init_db(&conn).unwrap_or_else(|err| {
        eprintln!("Failed to initialize local database: {}", err);
        std::process::exit(1);
    });
    conn
}

fn normalized_selector(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn resolve_member_selector(
    members: &[AddressableMember],
    selector: &str,
) -> Result<String, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("peer selector is required".to_string());
    }

    if selector.starts_with("kd_") {
        return Ok(selector.to_string());
    }

    let normalized = normalized_selector(selector);
    let mut display_matches: Vec<&AddressableMember> = members
        .iter()
        .filter(|member| {
            member
                .display_name
                .as_deref()
                .map(normalized_selector)
                .as_deref()
                == Some(normalized.as_str())
        })
        .collect();
    if display_matches.len() == 1 {
        return Ok(display_matches.remove(0).node_id.clone());
    }
    if display_matches.len() > 1 {
        let candidates = display_matches
            .into_iter()
            .map(|member| member.node_id.clone())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "selector '{}' matched multiple members: {}",
            selector, candidates
        ));
    }

    let role_selector = if normalized == "owner" {
        Some("owner".to_string())
    } else {
        normalized
            .strip_prefix("role:")
            .map(|role| role.to_string())
    };
    if let Some(role_selector) = role_selector {
        let mut role_matches: Vec<&AddressableMember> = members
            .iter()
            .filter(|member| {
                member.role.as_deref().map(normalized_selector).as_deref()
                    == Some(role_selector.as_str())
            })
            .collect();
        if role_matches.len() == 1 {
            return Ok(role_matches.remove(0).node_id.clone());
        }
        if role_matches.len() > 1 {
            let candidates = role_matches
                .into_iter()
                .map(|member| member.node_id.clone())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "selector '{}' matched multiple {} members: {}",
                selector, role_selector, candidates
            ));
        }
    }

    Err(format!(
        "could not resolve '{}' to a node ID; use `bridges members --project <id>` to inspect candidates",
        selector
    ))
}

fn try_fetch_project_members_json(
    cfg: &ClientConfig,
    project_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let client = authed_client(cfg);
    let url = format!("{}/v1/projects/{}/members", cfg.coordination, project_id);
    let resp = client
        .get(&url)
        .send()
        .map_err(|err| format!("members request failed: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!("members request returned HTTP {}", resp.status()));
    }
    resp.json::<Vec<serde_json::Value>>()
        .map_err(|err| format!("failed to parse members response: {}", err))
}

fn fetch_project_members_json(project_id: &str) -> Vec<serde_json::Value> {
    let cfg = ClientConfig::load_or_exit();
    match try_fetch_project_members_json(&cfg, project_id) {
        Ok(members) => members,
        Err(err) => {
            eprintln!("Members failed: {}", err);
            std::process::exit(1);
        }
    }
}

fn load_project_members(project_id: &str) -> Vec<AddressableMember> {
    fetch_project_members_json(project_id)
        .into_iter()
        .map(|member| AddressableMember {
            node_id: member["nodeId"].as_str().unwrap_or_default().to_string(),
            display_name: member["displayName"].as_str().map(|v| v.to_string()),
            role: member["agentRole"].as_str().map(|v| v.to_string()),
        })
        .filter(|member| !member.node_id.is_empty())
        .collect()
}

fn resolve_peer_selector_or_exit(selector: &str, project_id: Option<&str>) -> String {
    if selector.trim().starts_with("kd_") {
        return selector.trim().to_string();
    }
    let Some(project_id) = project_id.filter(|project_id| !project_id.trim().is_empty()) else {
        eprintln!(
            "Non-node peer selectors require --project so Bridges can resolve project members."
        );
        std::process::exit(1);
    };
    let members = load_project_members(project_id);
    resolve_member_selector(&members, selector).unwrap_or_else(|err| {
        eprintln!("Address resolution failed: {}", err);
        std::process::exit(1);
    })
}

/// Ensure the daemon is running. Auto-starts it if not.
pub fn ensure_daemon() {
    let port = std::env::var("BRIDGES_DAEMON_PORT").unwrap_or_else(|_| "7070".to_string());
    let url = format!("http://127.0.0.1:{}/status", port);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build daemon probe client: {}", err);
            std::process::exit(1);
        });

    if client.get(&url).send().is_ok() {
        return;
    }

    if crate::service::try_start_service_if_installed() {
        eprintln!("Starting daemon service...");
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if client.get(&url).send().is_ok() {
                return;
            }
        }
        eprintln!("Warning: daemon service started but not yet responding");
        return;
    }

    let exe = std::env::current_exe().unwrap_or_else(|_| "bridges".into());
    match std::process::Command::new(&exe)
        .arg("daemon")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(_) => {
            eprintln!("Starting daemon...");
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if client.get(&url).send().is_ok() {
                    return;
                }
            }
            eprintln!("Warning: daemon started but not yet responding");
        }
        Err(e) => {
            eprintln!("Failed to start daemon: {}", e);
            std::process::exit(1);
        }
    }
}

/// List same-server contacts.
pub fn cmd_contacts_list() {
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/contacts", cfg.coordination);
    let resp = send_or_exit(&client, &url, None, "GET");
    if !resp.status().is_success() {
        eprintln!("Contacts failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let contacts: Vec<crate::coord_client::ContactInfo> = parse_json_or_exit(resp);
    if contacts.is_empty() {
        println!("No same-server contacts yet.");
        return;
    }
    println!("Contacts:");
    for contact in &contacts {
        println!(
            "  {} ({}) [{}]",
            contact.node_id,
            contact
                .display_name
                .as_deref()
                .or(contact.owner_name.as_deref())
                .unwrap_or("?"),
            contact.runtime.as_deref().unwrap_or("bridge-node")
        );
    }
}

/// Add a same-server contact. The current contact model is symmetric.
pub fn cmd_contacts_add(node_id: &str) {
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/contacts/{}", cfg.coordination, node_id.trim());
    let resp = send_or_exit(&client, &url, None, "PUT");
    if !resp.status().is_success() {
        eprintln!("Add contact failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    println!("Added contact {}", node_id.trim());
}

/// Remove a same-server contact from both sides.
pub fn cmd_contacts_remove(node_id: &str) {
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/contacts/{}", cfg.coordination, node_id.trim());
    let resp = send_or_exit(&client, &url, None, "DELETE");
    if !resp.status().is_success() {
        eprintln!("Remove contact failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    println!("Removed contact {}", node_id.trim());
}

fn daemon_url() -> String {
    let port = std::env::var("BRIDGES_DAEMON_PORT").unwrap_or_else(|_| "7070".to_string());
    format!("http://127.0.0.1:{}", port)
}

enum PolledOutcome {
    Response { from: String, text: String },
    Failure { from: Option<String>, error: String },
}

/// Poll the daemon for a staged delivery outcome by request_id. Blocks until terminal outcome or timeout.
fn poll_response(request_id: &str, timeout_secs: u64) -> Option<PolledOutcome> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build polling client: {}", err);
            std::process::exit(1);
        });
    let url = format!("{}/response/{}", daemon_url(), request_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let mut last_stage = String::new();

    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send() {
            if let Ok(val) = resp.json::<serde_json::Value>() {
                let stage = val["stage"].as_str().unwrap_or("");
                if !stage.is_empty() && stage != "unknown" && stage != last_stage {
                    match stage {
                        "handed_off_direct" => {
                            eprintln!("  delivery stage: handed off over direct transport")
                        }
                        "handed_off_mailbox" => {
                            eprintln!("  delivery stage: handed off through mailbox relay")
                        }
                        "received_by_peer_daemon" => {
                            eprintln!("  delivery stage: peer daemon received the request")
                        }
                        "processing_failed" => {
                            eprintln!("  delivery stage: peer reported processing failure")
                        }
                        "processed_by_peer_runtime" => {
                            eprintln!("  delivery stage: peer runtime processed the request")
                        }
                        other => eprintln!("  delivery stage: {}", other),
                    }
                    last_stage = stage.to_string();
                }
                if val["ready"].as_bool() == Some(true) {
                    let from = val["from_node"].as_str().unwrap_or("?").to_string();
                    let text = val["response"].as_str().unwrap_or("").to_string();
                    return Some(PolledOutcome::Response { from, text });
                }
                if val["terminal"].as_bool() == Some(true) {
                    let from = val["from_node"].as_str().map(|v| v.to_string());
                    let error = val["error"]
                        .as_str()
                        .unwrap_or("request failed without a reported error")
                        .to_string();
                    return Some(PolledOutcome::Failure { from, error });
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    None
}

/// Resolve project directory from project ID in local DB.
fn resolve_project_dir(project_id: &str) -> Option<std::path::PathBuf> {
    let conn = open_local_db_or_exit();
    crate::queries::get_project_path(&conn, project_id).map(std::path::PathBuf::from)
}

fn require_local_project_dir(project_id: &str) -> std::path::PathBuf {
    resolve_project_dir(project_id).unwrap_or_else(|| {
        eprintln!("Unknown local project: {}", project_id);
        eprintln!("Join or create the project on this machine first.");
        std::process::exit(1);
    })
}

pub fn cmd_session_list(project_id: &str, peer_id: &str) {
    require_project_id(project_id);
    let project_dir = require_local_project_dir(project_id);
    let project_dir = project_dir.to_string_lossy().to_string();
    let sessions =
        crate::conversation_memory::list_sessions(&project_dir, peer_id).unwrap_or_else(|e| {
            eprintln!("Session list failed: {}", e);
            std::process::exit(1);
        });

    if sessions.is_empty() {
        println!("No conversation sessions for {} in {}", peer_id, project_id);
        return;
    }

    println!("Sessions for {} in {}:", peer_id, project_id);
    for session in sessions {
        let active = if session.active { " [active]" } else { "" };
        let summary = if session.has_summary { " yes" } else { " no" };
        let updated = session
            .last_timestamp
            .unwrap_or_else(|| "never".to_string());
        println!(
            "  {}{}  exchanges={}  summary={}  updated={}",
            session.session_id, active, session.exchange_count, summary, updated
        );
    }
}

pub fn cmd_session_new(project_id: &str, peer_id: &str) {
    require_project_id(project_id);
    let project_dir = require_local_project_dir(project_id);
    let session_id =
        crate::conversation_memory::create_session(&project_dir.to_string_lossy(), peer_id)
            .unwrap_or_else(|e| {
                eprintln!("Session create failed: {}", e);
                std::process::exit(1);
            });
    println!("Created new active session for {}:", peer_id);
    println!("  {}", session_id);
}

pub fn cmd_session_use(project_id: &str, peer_id: &str, session_id: &str) {
    require_project_id(project_id);
    let project_dir = require_local_project_dir(project_id);
    crate::conversation_memory::use_session(&project_dir.to_string_lossy(), peer_id, session_id)
        .unwrap_or_else(|e| {
            eprintln!("Session switch failed: {}", e);
            std::process::exit(1);
        });
    println!("Active session for {} set to {}", peer_id, session_id);
}

pub fn cmd_session_reset(project_id: &str, peer_id: &str, session_id: Option<&str>, all: bool) {
    require_project_id(project_id);
    let project_dir = require_local_project_dir(project_id);
    let project_dir = project_dir.to_string_lossy().to_string();

    if all {
        crate::conversation_memory::reset_all_sessions(&project_dir, peer_id).unwrap_or_else(|e| {
            eprintln!("Session reset failed: {}", e);
            std::process::exit(1);
        });
        println!("Reset all sessions for {} in {}", peer_id, project_id);
        return;
    }

    let session_id = session_id.unwrap_or_else(|| {
        eprintln!("Provide --session <id> or use --all");
        std::process::exit(1);
    });
    crate::conversation_memory::reset_session(&project_dir, peer_id, session_id).unwrap_or_else(
        |e| {
            eprintln!("Session reset failed: {}", e);
            std::process::exit(1);
        },
    );
    println!(
        "Reset session {} for {} in {}",
        session_id, peer_id, project_id
    );
}

/// Ask another agent a question — sends E2E encrypted and waits for a response.
pub fn cmd_ask(node_id: &str, question: &str, project_id: Option<&str>, new_session: bool) {
    ensure_daemon();

    let pid = project_id.unwrap_or("");
    let resolved_node_id = resolve_peer_selector_or_exit(node_id, project_id);

    let client = reqwest::blocking::Client::new();
    let url = format!("{}/ask", daemon_url());
    let body = serde_json::json!({
        "node_id": resolved_node_id,
        "question": question,
        "project_id": pid,
        "new_session": new_session,
    });
    let resp = match client.post(&url).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Daemon unreachable: {}", e);
            std::process::exit(1);
        }
    };
    if !resp.status().is_success() {
        eprintln!("Ask failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    if val["ok"].as_bool() != Some(true) {
        eprintln!("Ask failed: {}", val["error"].as_str().unwrap_or("unknown"));
        std::process::exit(1);
    }

    let request_id = match val["request_id"].as_str() {
        Some(id) => id,
        None => {
            println!("Sent (E2E encrypted)");
            return;
        }
    };

    eprintln!("Waiting for response from {}...", resolved_node_id);
    match poll_response(request_id, 120) {
        Some(PolledOutcome::Response { from, text }) => {
            println!("[Response from {}]\n{}", from, text);
        }
        Some(PolledOutcome::Failure { from, error }) => {
            if let Some(from) = from {
                eprintln!("Peer {} reported failure: {}", from, error);
            } else {
                eprintln!("Peer reported failure: {}", error);
            }
            std::process::exit(1);
        }
        None => {
            eprintln!("Timeout: no response received within 120 seconds");
            std::process::exit(1);
        }
    }
}

/// Start a debate — sends to all members and collects responses.
pub fn cmd_debate(topic: &str, project_id: &str, new_session: bool) {
    ensure_daemon();
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/debate", daemon_url());
    let body = serde_json::json!({
        "topic": topic,
        "project_id": project_id,
        "new_session": new_session,
    });
    let resp = match client.post(&url).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Daemon unreachable: {}", e);
            std::process::exit(1);
        }
    };
    if !resp.status().is_success() {
        eprintln!("Debate failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let sent_to = val["sent_to"].as_array().map(|a| a.len()).unwrap_or(0);
    if sent_to == 0 {
        println!("No members to debate with");
        return;
    }

    let request_ids: Vec<String> = val["request_ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if request_ids.is_empty() {
        println!("Debate sent to {} members (E2E encrypted)", sent_to);
        return;
    }

    eprintln!("Waiting for {} responses...", request_ids.len());
    for request_id in &request_ids {
        match poll_response(request_id, 120) {
            Some(PolledOutcome::Response { from, text }) => {
                println!("\n[Response from {}]\n{}", from, text);
            }
            Some(PolledOutcome::Failure { from, error }) => {
                if let Some(from) = from {
                    eprintln!(
                        "Peer {} reported failure for {}: {}",
                        from, request_id, error
                    );
                } else {
                    eprintln!("Peer reported failure for {}: {}", request_id, error);
                }
            }
            None => {
                eprintln!("Timeout waiting for response to {}", request_id);
            }
        }
    }
}

/// Broadcast a message to all project members — routed through local daemon (E2E encrypted).
pub fn cmd_broadcast(message: &str, project_id: &str) {
    ensure_daemon();
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/broadcast", daemon_url());
    let body = serde_json::json!({
        "message": message,
        "project_id": project_id,
        "message_type": "broadcast",
    });
    let resp = match client.post(&url).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Daemon unreachable: {}", e);
            std::process::exit(1);
        }
    };
    if !resp.status().is_success() {
        eprintln!("Broadcast failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let targets = val["sent_to"].as_array().map(|a| a.len()).unwrap_or(0);
    println!("Broadcast sent to {} members (E2E encrypted)", targets);
}

/// Publish a file as an artifact to all project members — routed through local daemon (E2E encrypted).
pub fn cmd_publish(file: &str, project_id: &str) {
    ensure_daemon();
    let data = std::fs::read(file).unwrap_or_else(|e| {
        eprintln!("Cannot read {}: {}", file, e);
        std::process::exit(1);
    });
    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
    let filename = std::path::Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");

    let client = reqwest::blocking::Client::new();
    let url = format!("{}/publish", daemon_url());
    let body = serde_json::json!({
        "filename": filename,
        "data": encoded,
        "project_id": project_id,
    });
    let resp = match client.post(&url).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Daemon unreachable: {}", e);
            std::process::exit(1);
        }
    };
    if !resp.status().is_success() {
        eprintln!("Publish failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    println!(
        "Published {} to project {} (E2E encrypted)",
        filename, project_id
    );
}

/// Build a blocking reqwest client with Bearer auth.
fn authed_client(cfg: &ClientConfig) -> reqwest::blocking::Client {
    use reqwest::header;
    let mut headers = header::HeaderMap::new();
    let val = format!("Bearer {}", cfg.api_key);
    let header_value = header::HeaderValue::from_str(&val).unwrap_or_else(|err| {
        eprintln!("Failed to build authorization header: {}", err);
        std::process::exit(1);
    });
    headers.insert(header::AUTHORIZATION, header_value);
    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build authenticated client: {}", err);
            std::process::exit(1);
        })
}

/// Send a blocking HTTP request or exit on network error.
fn send_or_exit(
    client: &reqwest::blocking::Client,
    url: &str,
    body: Option<&serde_json::Value>,
    method: &str,
) -> reqwest::blocking::Response {
    let req = match method {
        "GET" => client.get(url),
        _ => {
            let mut r = client.post(url);
            if let Some(b) = body {
                r = r.json(b);
            }
            r
        }
    };
    match req.send() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Request to {} failed: {}", url, e);
            std::process::exit(1);
        }
    }
}

/// Parse a JSON response or exit on parse error.
fn parse_json_or_exit<T: serde::de::DeserializeOwned>(resp: reqwest::blocking::Response) -> T {
    match resp.json::<T>() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Invalid response from server: {}", e);
            std::process::exit(1);
        }
    }
}

fn require_project_id(project_id: &str) {
    if !project_id.starts_with("proj_") {
        eprintln!(
            "Project must be a project ID like proj_xxx, not a slug/name: {}",
            project_id
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_member_selector_accepts_unique_display_name() {
        let members = vec![
            AddressableMember {
                node_id: "kd_alice".to_string(),
                display_name: Some("Alice".to_string()),
                role: Some("owner".to_string()),
            },
            AddressableMember {
                node_id: "kd_bob".to_string(),
                display_name: Some("Bob".to_string()),
                role: Some("member".to_string()),
            },
        ];

        let resolved = resolve_member_selector(&members, "alice").unwrap();
        assert_eq!(resolved, "kd_alice");
    }

    #[test]
    fn resolve_member_selector_supports_owner_and_role_selectors() {
        let members = vec![
            AddressableMember {
                node_id: "kd_owner".to_string(),
                display_name: Some("Alice".to_string()),
                role: Some("owner".to_string()),
            },
            AddressableMember {
                node_id: "kd_ops".to_string(),
                display_name: Some("Ops".to_string()),
                role: Some("infra".to_string()),
            },
        ];

        assert_eq!(
            resolve_member_selector(&members, "owner").unwrap(),
            "kd_owner"
        );
        assert_eq!(
            resolve_member_selector(&members, "role:infra").unwrap(),
            "kd_ops"
        );
    }

    #[test]
    fn resolve_member_selector_reports_ambiguity() {
        let members = vec![
            AddressableMember {
                node_id: "kd_alice_1".to_string(),
                display_name: Some("Alice".to_string()),
                role: Some("member".to_string()),
            },
            AddressableMember {
                node_id: "kd_alice_2".to_string(),
                display_name: Some("Alice".to_string()),
                role: Some("member".to_string()),
            },
        ];

        let err = resolve_member_selector(&members, "alice").unwrap_err();
        assert!(err.contains("matched multiple members"));
    }
}
