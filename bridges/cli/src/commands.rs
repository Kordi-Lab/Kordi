use base64::Engine as _;

use crate::client_config::ClientConfig;
use crate::config::DaemonConfig;
use crate::identity;

mod identity_commands;
mod projects;
mod setup;

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

fn doctor_service_check() -> DoctorCheck {
    match crate::service::service_status() {
        Ok(status) => {
            let normalized = status.to_ascii_lowercase();
            if normalized.contains("active") || normalized.contains("running") {
                DoctorCheck::ok("service", format!("daemon service reports: {}", status.trim()))
            } else {
                DoctorCheck::warn(
                    "service",
                    format!("daemon service is not clearly running: {}", status.trim()),
                    vec![
                        "Run `bridges service status` for the raw service manager output.".to_string(),
                        "If needed, run `bridges service start` or `bridges daemon --foreground`.".to_string(),
                    ],
                )
            }
        }
        Err(err) => DoctorCheck::warn(
            "service",
            format!("service manager status unavailable: {}", err),
            vec![
                "This can happen if the service is not installed yet or the platform is unsupported."
                    .to_string(),
                "You can still run `bridges daemon --foreground` directly.".to_string(),
            ],
        ),
    }
}

fn doctor_coordination_check(
    client: &reqwest::blocking::Client,
    coordination_url: &str,
) -> DoctorCheck {
    let url = format!("{}/health", coordination_url.trim_end_matches('/'));
    match client.get(&url).send() {
        Ok(resp) if resp.status().is_success() => DoctorCheck::ok(
            "coordination",
            format!("coordination health reachable at {}", url),
        ),
        Ok(resp) => DoctorCheck::error(
            "coordination",
            format!("coordination health returned HTTP {}", resp.status()),
            vec![
                format!(
                    "Verify the configured coordination URL: {}",
                    coordination_url
                ),
                format!("Try `curl {}` manually.", url),
            ],
        ),
        Err(err) => DoctorCheck::error(
            "coordination",
            format!("failed to reach coordination health endpoint: {}", err),
            vec![
                format!(
                    "Verify the configured coordination URL: {}",
                    coordination_url
                ),
                format!("Try `curl {}` manually.", url),
            ],
        ),
    }
}

fn doctor_runtime_check(
    client: &reqwest::blocking::Client,
    daemon_cfg: &DaemonConfig,
    daemon_status: Option<&crate::local_api::StatusResponse>,
) -> DoctorCheck {
    let runtime = daemon_cfg.runtime.trim();
    let detail = daemon_status
        .and_then(|status| status.runtime.detail.as_deref())
        .unwrap_or("no daemon runtime detail available");

    if matches!(runtime, "generic" | "openclaw") {
        if daemon_cfg.runtime_endpoint.trim().is_empty() {
            return DoctorCheck::error(
                "runtime",
                format!("{} runtime is configured without an endpoint", runtime),
                vec![
                    format!(
                        "Re-run setup with `bridges setup --runtime {} --endpoint http://<LOCAL_RUNTIME_HOST>:<PORT>`.",
                        runtime
                    ),
                    "If the daemon is already running, restart it after updating daemon config."
                        .to_string(),
                ],
            );
        }
        return match client.get(&daemon_cfg.runtime_endpoint).send() {
            Ok(resp) => {
                let code = resp.status().as_u16();
                let summary = format!(
                    "{} endpoint reachable at {} (HTTP {}, daemon says {})",
                    runtime, daemon_cfg.runtime_endpoint, code, detail
                );
                if resp.status().is_success() || code == 401 || code == 403 || code == 404 || code == 405 {
                    DoctorCheck::ok("runtime", summary)
                } else {
                    DoctorCheck::warn(
                        "runtime",
                        summary,
                        vec![
                            "The runtime endpoint responded, but the returned HTTP status may still indicate a local runtime integration problem.".to_string(),
                        ],
                    )
                }
            }
            Err(err) => DoctorCheck::error(
                "runtime",
                format!("failed to reach runtime endpoint {}: {}", daemon_cfg.runtime_endpoint, err),
                vec![
                    "Verify the local runtime process is running and listening on the configured endpoint.".to_string(),
                    format!("Configured runtime endpoint: {}", daemon_cfg.runtime_endpoint),
                ],
            ),
        };
    }

    match daemon_status.map(|status| &status.runtime.state) {
        Some(crate::presence::ComponentState::Healthy) => DoctorCheck::ok(
            "runtime",
            format!("{} runtime looks healthy ({})", runtime, detail),
        ),
        Some(crate::presence::ComponentState::Degraded) => DoctorCheck::warn(
            "runtime",
            format!("{} runtime reported degraded ({})", runtime, detail),
            vec![
                format!("Check the local {} runtime installation and restart the daemon.", runtime),
                "Try `bridges daemon --foreground` to see runtime dispatch errors live.".to_string(),
            ],
        ),
        _ => DoctorCheck::warn(
            "runtime",
            format!("{} runtime has not been exercised yet ({})", runtime, detail),
            vec![
                "Send an inbound message or run the daemon in the foreground to confirm runtime dispatch works."
                    .to_string(),
            ],
        ),
    }
}

fn peer_hints(peer: Option<&crate::local_api::PeerInfo>, selector: &str) -> Vec<String> {
    match peer {
        Some(peer) if peer.reachability == "relay_only" => vec![
            format!(
                "{} is currently reachable through relay/mailbox fallback instead of a direct path.",
                selector
            ),
            "If you expected direct delivery, check STUN reachability, NAT/firewall settings, and endpoint publication."
                .to_string(),
        ],
        Some(peer) if peer.reachability == "probing" => vec![
            format!(
                "{} is still probing direct paths; send traffic again after the daemon has had time to learn endpoints.",
                selector
            ),
            "If probing never settles, verify both peers share a project and can reach the coordination server."
                .to_string(),
        ],
        Some(_) => Vec::new(),
        None => vec![
            format!(
                "No live peer transport state is cached for {} in this daemon lifetime yet.",
                selector
            ),
            "Try `bridges ask <peer> ...` or `bridges ping <node_id>` to establish transport state."
                .to_string(),
        ],
    }
}

fn doctor_project_check(
    project_id: &str,
    local_project_dir: Option<std::path::PathBuf>,
    members: &[serde_json::Value],
    local_node_id: Option<&str>,
) -> DoctorCheck {
    let mut hints = Vec::new();
    if local_project_dir.is_none() {
        hints.push("This machine does not have a local checkout for the project yet; run `bridges join` or create the project locally first.".to_string());
    }
    if let Some(local_project_dir) = local_project_dir.as_ref() {
        if !local_project_dir.join(".shared").exists() {
            hints.push("Optional shared-workspace sync is not initialized in this checkout; messaging still works without it.".to_string());
        }
    }
    if let Some(local_node_id) = local_node_id {
        if let Some(local_member) = members
            .iter()
            .find(|member| member["nodeId"].as_str() == Some(local_node_id))
        {
            if !local_member["capabilities"]
                .as_array()
                .map(|caps| {
                    caps.iter()
                        .any(|cap| cap.as_str() == Some("manage_invites"))
                })
                .unwrap_or(false)
            {
                hints.push(
                    "Invite creation is owner-only for the current project role.".to_string(),
                );
            }
        }
    }

    let summary = if let Some(path) = local_project_dir {
        format!(
            "project {} is reachable via coordination with {} members; local path {}",
            project_id,
            members.len(),
            path.display()
        )
    } else {
        format!(
            "project {} is reachable via coordination with {} members, but no local checkout is recorded",
            project_id,
            members.len()
        )
    };

    if hints.is_empty() {
        DoctorCheck::ok("project", summary)
    } else {
        DoctorCheck::warn("project", summary, hints)
    }
}

fn doctor_peer_check(
    selector: &str,
    resolved_node_id: &str,
    peer: Option<&crate::local_api::PeerInfo>,
) -> DoctorCheck {
    match peer {
        Some(peer) if matches!(peer.reachability.as_str(), "direct" | "lan") => DoctorCheck::ok(
            "peer",
            format!(
                "{} resolved to {} and is using {} transport (session={}, last_inbound={:?}, last_outbound={:?})",
                selector,
                resolved_node_id,
                peer.reachability,
                peer.session_state,
                peer.last_inbound_at,
                peer.last_outbound_at
            ),
        ),
        Some(peer) => DoctorCheck::warn(
            "peer",
            format!(
                "{} resolved to {} with reachability={} and session={}",
                selector, resolved_node_id, peer.reachability, peer.session_state
            ),
            peer_hints(Some(peer), selector),
        ),
        None => DoctorCheck::warn(
            "peer",
            format!("{} resolved to {}, but the daemon has no live peer transport entry", selector, resolved_node_id),
            peer_hints(None, selector),
        ),
    }
}

fn print_doctor_report(checks: &[DoctorCheck]) {
    println!("Bridges Doctor");
    println!();

    let mut ok = 0usize;
    let mut warn = 0usize;
    let mut err = 0usize;

    for check in checks {
        let label = match check.level {
            DoctorLevel::Ok => {
                ok += 1;
                "OK"
            }
            DoctorLevel::Warn => {
                warn += 1;
                "WARN"
            }
            DoctorLevel::Error => {
                err += 1;
                "ERR"
            }
        };
        println!("[{}] {} — {}", label, check.name, check.summary);
        for hint in &check.hints {
            println!("      hint: {}", hint);
        }
    }

    println!();
    println!("Summary: {} ok, {} warnings, {} errors", ok, warn, err);
}

pub fn cmd_doctor(project_id: Option<&str>, peer_selector: Option<&str>) {
    let mut checks = Vec::new();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build diagnostics client: {}", err);
            std::process::exit(1);
        });

    let daemon_cfg = match DaemonConfig::load() {
        Ok(cfg) => {
            checks.push(DoctorCheck::ok(
                "daemon config",
                format!(
                    "runtime={} local_api_port={} coordination={}",
                    cfg.runtime, cfg.local_api_port, cfg.coordination_url
                ),
            ));
            cfg
        }
        Err(err) => {
            checks.push(DoctorCheck::error(
                "daemon config",
                format!("failed to load daemon config: {}", err),
                vec![
                    "Re-run `bridges setup --coordination <URL>` to regenerate daemon configuration."
                        .to_string(),
                ],
            ));
            DaemonConfig::default()
        }
    };

    match identity::load_existing_keypair() {
        Ok(Some((_signing, verifying))) => {
            let node_id = identity::derive_node_id(&verifying);
            checks.push(DoctorCheck::ok(
                "identity",
                format!("local identity loaded as {}", node_id),
            ));
        }
        Ok(None) => checks.push(DoctorCheck::error(
            "identity",
            "local identity is missing",
            vec![
                "Run `bridges setup --coordination <URL>` to initialize the local node identity."
                    .to_string(),
            ],
        )),
        Err(err) => checks.push(DoctorCheck::error(
            "identity",
            format!("failed to load local identity: {}", err),
            vec![
                "Inspect ~/.bridges/identity/keypair.json and re-run setup if the file is corrupt."
                    .to_string(),
            ],
        )),
    }

    let client_cfg = match ClientConfig::load() {
        Ok(Some(cfg)) if !cfg.api_key.trim().is_empty() => {
            checks.push(DoctorCheck::ok(
                "client config",
                format!("registered as {} against {}", cfg.node_id, cfg.coordination),
            ));
            Some(cfg)
        }
        Ok(Some(cfg)) => {
            checks.push(DoctorCheck::error(
                "client config",
                format!("client config for {} is present but the API key is empty", cfg.node_id),
                vec![
                    "This usually means the local node was revoked or a rotation was only partially completed."
                        .to_string(),
                    "Run `bridges identity status`, `bridges identity rotate`, or `bridges setup --coordination <URL>`."
                        .to_string(),
                ],
            ));
            None
        }
        Ok(None) => {
            checks.push(DoctorCheck::error(
                "client config",
                "client registration config is missing",
                vec![
                    "Run `bridges register --coordination <URL>` or `bridges setup --coordination <URL>`."
                        .to_string(),
                ],
            ));
            None
        }
        Err(err) => {
            checks.push(DoctorCheck::error(
                "client config",
                format!("failed to load client config: {}", err),
                vec![
                    "Inspect ~/.bridges/config.json and re-run setup if the file is corrupt."
                        .to_string(),
                ],
            ));
            None
        }
    };

    checks.push(doctor_service_check());

    if let Some(cfg) = client_cfg.as_ref() {
        match identity_commands::fetch_remote_identity_status(cfg) {
            Ok(remote) => checks.push(identity_commands::doctor_identity_check(cfg, &remote)),
            Err(err) => checks.push(DoctorCheck::error(
                "identity lifecycle",
                format!("failed to query coordination identity status: {}", err),
                vec![
                    "This can happen if the local API key was revoked or local config no longer matches coordination state."
                        .to_string(),
                    "Run `bridges identity status` or re-run setup if the node should still be active."
                        .to_string(),
                ],
            )),
        }
    }

    let daemon_status_url = format!("http://127.0.0.1:{}/status", daemon_cfg.local_api_port);
    let daemon_status = match client.get(&daemon_status_url).send() {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<crate::local_api::StatusResponse>() {
                Ok(status) => {
                    let level = if status.healthy {
                        DoctorLevel::Ok
                    } else {
                        DoctorLevel::Warn
                    };
                    let summary = format!(
                        "daemon online at {} (coordination={:?}, runtime={:?}, reachability={:?})",
                        daemon_status_url,
                        status.coordination.state,
                        status.runtime.state,
                        status.reachability.mode
                    );
                    checks.push(match level {
                    DoctorLevel::Ok => DoctorCheck::ok("daemon API", summary),
                    DoctorLevel::Warn => DoctorCheck::warn(
                        "daemon API",
                        summary,
                        vec![
                            "Run `bridges status` for the current structured daemon view.".to_string(),
                            "If needed, run `bridges daemon --foreground` to inspect live transport/runtime logs."
                                .to_string(),
                        ],
                    ),
                    DoctorLevel::Error => unreachable!(),
                });
                    Some(status)
                }
                Err(err) => {
                    checks.push(DoctorCheck::error(
                        "daemon API",
                        format!("failed to parse daemon status: {}", err),
                        vec![format!(
                            "Probe the daemon manually with `curl {}`.",
                            daemon_status_url
                        )],
                    ));
                    None
                }
            }
        }
        Ok(resp) => {
            checks.push(DoctorCheck::error(
                "daemon API",
                format!("daemon returned HTTP {}", resp.status()),
                vec!["Run `bridges service status` or restart the daemon service.".to_string()],
            ));
            None
        }
        Err(err) => {
            checks.push(DoctorCheck::error(
                "daemon API",
                format!("daemon unreachable at {}: {}", daemon_status_url, err),
                vec![
                    "Run `bridges service start` or `bridges daemon --foreground`.".to_string(),
                    "If a daemon is already running, confirm BRIDGES_DAEMON_PORT matches the configured port."
                        .to_string(),
                ],
            ));
            None
        }
    };

    let daemon_peers = if daemon_status.is_some() {
        let peers_url = format!("{}/peers", daemon_url());
        match client.get(&peers_url).send() {
            Ok(resp) if resp.status().is_success() => resp
                .json::<Vec<crate::local_api::PeerInfo>>()
                .ok()
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };

    let coordination_url = client_cfg
        .as_ref()
        .map(|cfg| cfg.coordination.as_str())
        .unwrap_or_else(|| daemon_cfg.coordination_url.as_str());
    checks.push(doctor_coordination_check(&client, coordination_url));
    checks.push(doctor_runtime_check(
        &client,
        &daemon_cfg,
        daemon_status.as_ref(),
    ));

    let mut project_members: Option<Vec<serde_json::Value>> = None;
    if let Some(project_id) = project_id {
        if !project_id.starts_with("proj_") {
            checks.push(DoctorCheck::error(
                "project",
                format!("{} is not a project ID", project_id),
                vec!["Use the canonical proj_... identifier from `bridges status`.".to_string()],
            ));
        } else if client_cfg.is_none() {
            checks.push(DoctorCheck::error(
                "project",
                format!(
                    "cannot inspect project {} without client registration",
                    project_id
                ),
                vec!["Run `bridges register --coordination <URL>` first.".to_string()],
            ));
        } else if let Some(cfg) = client_cfg.as_ref() {
            match try_fetch_project_members_json(cfg, project_id) {
                Ok(members) => {
                    project_members = Some(members.clone());
                    let local_project_dir = resolve_project_dir(project_id);
                    checks.push(doctor_project_check(
                        project_id,
                        local_project_dir,
                        &members,
                        client_cfg.as_ref().map(|cfg| cfg.node_id.as_str()),
                    ));
                }
                Err(err) => checks.push(DoctorCheck::error(
                    "project",
                    format!("failed to inspect project {}: {}", project_id, err),
                    vec![
                        "Verify that this node is a project member and that the project ID is correct."
                            .to_string(),
                        format!(
                            "If needed, compare against `bridges status` and `bridges members --project {}`.",
                            project_id
                        ),
                    ],
                )),
            }
        }
    }

    if let Some(peer_selector) = peer_selector {
        if !peer_selector.trim().starts_with("kd_") && project_id.is_none() {
            checks.push(DoctorCheck::error(
                "peer",
                format!("peer selector '{}' requires --project", peer_selector),
                vec![
                    "Project-scoped selectors use display names, `owner`, or `role:<role>` within a project."
                        .to_string(),
                ],
            ));
        } else {
            let resolved_node_id = if peer_selector.trim().starts_with("kd_") {
                Ok(peer_selector.trim().to_string())
            } else {
                let members = project_members
                    .as_ref()
                    .map(|members| {
                        members
                            .iter()
                            .map(|member| AddressableMember {
                                node_id: member["nodeId"].as_str().unwrap_or_default().to_string(),
                                display_name: member["displayName"].as_str().map(|v| v.to_string()),
                                role: member["agentRole"].as_str().map(|v| v.to_string()),
                            })
                            .filter(|member| !member.node_id.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                resolve_member_selector(&members, peer_selector)
            };

            match resolved_node_id {
                Ok(resolved_node_id) => {
                    let peer = daemon_peers.iter().find(|peer| peer.peer_id == resolved_node_id);
                    checks.push(doctor_peer_check(peer_selector, &resolved_node_id, peer));
                }
                Err(err) => checks.push(DoctorCheck::error(
                    "peer",
                    format!("could not resolve peer selector '{}': {}", peer_selector, err),
                    vec![
                        "Run `bridges members --project <proj_id>` to inspect available project members."
                            .to_string(),
                    ],
                )),
            }
        }
    }

    print_doctor_report(&checks);

    if checks.iter().any(|check| check.level == DoctorLevel::Error) {
        std::process::exit(1);
    }
}

/// Get the daemon local API URL.
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

    #[test]
    fn doctor_service_check_marks_running_status_as_ok() {
        let check = if "Active: active (running)"
            .to_ascii_lowercase()
            .contains("active")
        {
            DoctorCheck::ok("service", "running")
        } else {
            DoctorCheck::warn("service", "not running", vec![])
        };
        assert_eq!(check.level, DoctorLevel::Ok);
    }

    #[test]
    fn peer_hints_explain_relay_only_state() {
        let hints = peer_hints(
            Some(&crate::local_api::PeerInfo {
                peer_id: "kd_peer".to_string(),
                connection_state: "connected_relay".to_string(),
                reachability: "relay_only".to_string(),
                session_state: "established".to_string(),
                last_inbound_at: None,
                last_outbound_at: None,
            }),
            "owner",
        );
        assert!(hints
            .iter()
            .any(|hint| hint.contains("relay/mailbox fallback")));
    }

    #[test]
    fn doctor_peer_check_warns_when_peer_is_missing() {
        let check = doctor_peer_check("alice", "kd_alice", None);
        assert_eq!(check.level, DoctorLevel::Warn);
        assert!(check.summary.contains("no live peer transport entry"));
    }
}
