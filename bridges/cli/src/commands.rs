use base64::Engine as _;

use crate::client_config::ClientConfig;
use crate::config::DaemonConfig;
use crate::identity;

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeCandidate {
    name: &'static str,
    description: &'static str,
    detected: bool,
    detection_hint: String,
}

fn runtime_is_supported(runtime: &str) -> bool {
    matches!(runtime, "claude-code" | "codex" | "openclaw" | "generic")
}

fn runtime_requires_endpoint(runtime: &str) -> bool {
    matches!(runtime, "openclaw" | "generic")
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let candidate = dir.join(command);
                candidate.is_file()
            })
        })
        .unwrap_or(false)
}

fn detect_runtime_candidates() -> Vec<RuntimeCandidate> {
    let claude_detected = command_exists("claude");
    let codex_detected = command_exists("codex");
    let openclaw_detected = std::env::var("OPENCLAW_TOKEN").is_ok();

    vec![
        RuntimeCandidate {
            name: "claude-code",
            description: "local Claude Code CLI runtime",
            detected: claude_detected,
            detection_hint: if claude_detected {
                "detected `claude` on PATH".to_string()
            } else {
                "requires the `claude` CLI on PATH".to_string()
            },
        },
        RuntimeCandidate {
            name: "codex",
            description: "local Codex CLI runtime",
            detected: codex_detected,
            detection_hint: if codex_detected {
                "detected `codex` on PATH".to_string()
            } else {
                "requires the `codex` CLI on PATH".to_string()
            },
        },
        RuntimeCandidate {
            name: "openclaw",
            description: "local OpenClaw-compatible HTTP runtime",
            detected: openclaw_detected,
            detection_hint: if openclaw_detected {
                "OPENCLAW_TOKEN detected; still requires --endpoint".to_string()
            } else {
                "requires --endpoint to a local OpenClaw-compatible server".to_string()
            },
        },
        RuntimeCandidate {
            name: "generic",
            description: "generic OpenAI-compatible HTTP runtime",
            detected: false,
            detection_hint: "requires --endpoint to a local chat-completions server".to_string(),
        },
    ]
}

fn preferred_runtime(
    existing_runtime: Option<&str>,
    candidates: &[RuntimeCandidate],
) -> &'static str {
    if let Some(runtime) = existing_runtime.filter(|runtime| runtime_is_supported(runtime)) {
        return match runtime {
            "claude-code" => "claude-code",
            "codex" => "codex",
            "openclaw" => "openclaw",
            "generic" => "generic",
            _ => "generic",
        };
    }

    candidates
        .iter()
        .find(|candidate| candidate.detected && !runtime_requires_endpoint(candidate.name))
        .map(|candidate| candidate.name)
        .unwrap_or("generic")
}

fn prompt_line(prompt: &str, default: Option<&str>) -> String {
    use std::io::Write;

    let suffix = default
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [{}]", value))
        .unwrap_or_default();
    loop {
        print!("{}{}: ", prompt, suffix);
        let _ = std::io::stdout().flush();

        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_err() {
            eprintln!("Failed to read input. Please try again.");
            continue;
        }
        let trimmed = input.trim();
        if trimmed.is_empty() {
            if let Some(default) = default {
                return default.to_string();
            }
        } else {
            return trimmed.to_string();
        }
    }
}

fn prompt_optional_line(prompt: &str, default: Option<&str>) -> Option<String> {
    use std::io::Write;

    let suffix = default
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [{}]", value))
        .unwrap_or_default();
    print!("{}{}: ", prompt, suffix);
    let _ = std::io::stdout().flush();

    let mut input = String::new();
    if std::io::stdin().read_line(&mut input).is_err() {
        return default
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }

    let trimmed = input.trim();
    if trimmed.is_empty() {
        default
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    } else {
        Some(trimmed.to_string())
    }
}

fn prompt_runtime_choice(candidates: &[RuntimeCandidate], default_runtime: &str) -> String {
    println!("Select the local runtime Bridges should dispatch inbound work to:");
    for (idx, candidate) in candidates.iter().enumerate() {
        let availability = if candidate.detected {
            "detected"
        } else {
            "manual"
        };
        println!(
            "  {}. {} — {} ({}, {})",
            idx + 1,
            candidate.name,
            candidate.description,
            availability,
            candidate.detection_hint
        );
    }

    let default_index = candidates
        .iter()
        .position(|candidate| candidate.name == default_runtime)
        .unwrap_or(0);
    let default_choice = (default_index + 1).to_string();

    loop {
        let choice = prompt_line("Runtime choice", Some(&default_choice));
        match choice.parse::<usize>() {
            Ok(value) if (1..=candidates.len()).contains(&value) => {
                return candidates[value - 1].name.to_string();
            }
            _ => {
                eprintln!("Enter a number between 1 and {}.", candidates.len());
            }
        }
    }
}

fn validate_setup_runtime(runtime: &str, endpoint: &str) -> Result<(), String> {
    if !runtime_is_supported(runtime) {
        return Err(format!(
            "unsupported runtime '{}'; expected one of claude-code, codex, openclaw, generic",
            runtime
        ));
    }
    if runtime_requires_endpoint(runtime) && endpoint.trim().is_empty() {
        return Err(format!(
            "runtime '{}' requires --endpoint to point at a local HTTP runtime",
            runtime
        ));
    }
    Ok(())
}

fn wait_for_daemon_status(
    local_api_port: u16,
    timeout: std::time::Duration,
) -> Result<crate::local_api::StatusResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|err| format!("build daemon probe client: {}", err))?;
    let url = format!("http://127.0.0.1:{}/status", local_api_port);
    let deadline = std::time::Instant::now() + timeout;

    loop {
        let attempt_error = match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json::<crate::local_api::StatusResponse>()
                    .map_err(|err| format!("parse daemon status: {}", err));
            }
            Ok(resp) => format!("daemon returned HTTP {}", resp.status()),
            Err(err) => format!("daemon request failed: {}", err),
        };

        if std::time::Instant::now() >= deadline {
            return Err(attempt_error);
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn home_dir() -> Option<std::path::PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

fn skill_destination_for_runtime(
    runtime: &str,
    cwd: &std::path::Path,
    home: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    match runtime {
        "claude-code" => Some(cwd.join(".claude/skills/bridges")),
        "codex" => home.map(|home| home.join(".codex/skills/bridges")),
        "openclaw" => home.map(|home| home.join(".config/openclaw/skills/bridges")),
        _ => None,
    }
}

fn skill_install_check(runtime: &str, cwd: &std::path::Path) -> DoctorCheck {
    let home = home_dir();
    match runtime {
        "generic" => DoctorCheck::warn(
            "skill",
            "generic runtime selected; install `skills/bridges` into your agent runtime separately if you want natural-language Bridges control",
            vec![
                "For Pi, copy `skills/bridges` into ~/.agents/skills/bridges.".to_string(),
                "For custom runtimes, copy `skills/bridges/SKILL.md` and any helpers your runtime supports.".to_string(),
            ],
        ),
        "claude-code" | "codex" | "openclaw" => {
            let Some(destination) = skill_destination_for_runtime(runtime, cwd, home.as_deref()) else {
                return DoctorCheck::warn(
                    "skill",
                    format!("could not determine the default {} skill directory", runtime),
                    vec!["Copy `skills/bridges` into your agent runtime's skill folder manually.".to_string()],
                );
            };
            if destination.exists() {
                DoctorCheck::ok(
                    "skill",
                    format!("Bridges skill already present at {}", destination.display()),
                )
            } else {
                DoctorCheck::warn(
                    "skill",
                    format!("Bridges skill not found at {}", destination.display()),
                    vec![
                        format!(
                            "Copy `skills/bridges` into {} if you want {} to drive Bridges for you.",
                            destination.display(),
                            runtime
                        ),
                        "If you built Bridges from source, copy the skill from this repo checkout or see the README for runtime-specific install examples.".to_string(),
                    ],
                )
            }
        }
        _ => DoctorCheck::warn(
            "skill",
            format!("runtime '{}' has no built-in skill guidance", runtime),
            vec!["Copy `skills/bridges` into your agent runtime's skill folder manually.".to_string()],
        ),
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ShareableInvite {
    #[serde(rename = "v")]
    version: u8,
    coordination: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "inviteToken")]
    invite_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedInvite {
    coordination: Option<String>,
    project_id: String,
    invite_token: String,
}

fn encode_shareable_invite(
    coordination: &str,
    project_id: &str,
    invite_token: &str,
) -> Result<String, String> {
    let payload = ShareableInvite {
        version: 1,
        coordination: coordination.trim_end_matches('/').to_string(),
        project_id: project_id.to_string(),
        invite_token: invite_token.to_string(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|err| format!("failed to encode shareable invite payload: {}", err))?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    Ok(format!("bridges://join/{}", encoded))
}

fn decode_shareable_invite(value: &str) -> Result<Option<ShareableInvite>, String> {
    let trimmed = value.trim();
    let Some(encoded) = trimmed.strip_prefix("bridges://join/") else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|err| format!("invalid shareable invite encoding: {}", err))?;
    let invite: ShareableInvite = serde_json::from_slice(&bytes)
        .map_err(|err| format!("invalid shareable invite payload: {}", err))?;
    if invite.version != 1 {
        return Err(format!(
            "unsupported shareable invite version {}",
            invite.version
        ));
    }
    if invite.project_id.trim().is_empty() || invite.invite_token.trim().is_empty() {
        return Err("shareable invite is missing project or token data".to_string());
    }
    Ok(Some(invite))
}

fn resolve_join_invite(invite: &str, project_id: Option<&str>) -> Result<ResolvedInvite, String> {
    if let Some(bundle) = decode_shareable_invite(invite)? {
        if let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) {
            if project_id != bundle.project_id {
                return Err(format!(
                    "shareable invite targets project {}, but --project was {}",
                    bundle.project_id, project_id
                ));
            }
        }
        return Ok(ResolvedInvite {
            coordination: Some(bundle.coordination),
            project_id: bundle.project_id,
            invite_token: bundle.invite_token,
        });
    }

    let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) else {
        return Err(
            "raw invite tokens still require --project, or use the full `bridges://join/...` invite string"
                .to_string(),
        );
    };
    Ok(ResolvedInvite {
        coordination: None,
        project_id: project_id.to_string(),
        invite_token: invite.trim().to_string(),
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

/// Guided or flag-driven setup: generate keys, register, configure, install, and verify.
pub fn cmd_setup(
    coordination: Option<&str>,
    runtime: Option<&str>,
    endpoint: Option<&str>,
    name: Option<&str>,
    guided: bool,
) {
    println!("=== Bridges Setup ===\n");

    let existing_daemon_cfg = DaemonConfig::load().ok();
    let existing_client_cfg = ClientConfig::load().ok().flatten();
    let runtime_candidates = detect_runtime_candidates();

    let fallback_name = std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok());
    let default_coordination = coordination
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            existing_client_cfg
                .as_ref()
                .map(|cfg| cfg.coordination.trim().to_string())
        })
        .or_else(|| {
            existing_daemon_cfg
                .as_ref()
                .map(|cfg| cfg.coordination_url.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:17080".to_string());
    let default_runtime = runtime
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            existing_daemon_cfg
                .as_ref()
                .map(|cfg| cfg.runtime.trim().to_string())
                .filter(|value| runtime_is_supported(value))
        })
        .unwrap_or_else(|| preferred_runtime(None, &runtime_candidates).to_string());
    let default_endpoint = endpoint
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            existing_daemon_cfg
                .as_ref()
                .map(|cfg| cfg.runtime_endpoint.trim().to_string())
        })
        .unwrap_or_default();
    let default_name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            existing_client_cfg
                .as_ref()
                .and_then(|cfg| cfg.display_name.clone())
        })
        .or(fallback_name.clone());

    let interactive = guided || coordination.is_none();
    if interactive {
        println!("Guided setup mode\n");
        let detected = runtime_candidates
            .iter()
            .filter(|candidate| candidate.detected)
            .map(|candidate| candidate.name)
            .collect::<Vec<_>>();
        if detected.is_empty() {
            println!("Detected local runtimes: none (HTTP runtimes remain available)");
        } else {
            println!("Detected local runtimes: {}", detected.join(", "));
        }
        println!();
    }

    let coordination = if interactive {
        prompt_line("Coordination URL", Some(&default_coordination))
    } else {
        default_coordination
    };

    let runtime = if guided || runtime.is_none() {
        prompt_runtime_choice(&runtime_candidates, &default_runtime)
    } else {
        default_runtime
    };

    let endpoint = if runtime_requires_endpoint(&runtime) {
        if guided || endpoint.is_none() || default_endpoint.trim().is_empty() {
            prompt_line(
                "Runtime endpoint URL",
                if default_endpoint.trim().is_empty() {
                    None
                } else {
                    Some(&default_endpoint)
                },
            )
        } else {
            default_endpoint
        }
    } else {
        String::new()
    };

    let display_name = if interactive {
        prompt_optional_line("Display name", default_name.as_deref())
    } else {
        default_name
    };

    if coordination.trim().is_empty() {
        eprintln!("Setup requires a coordination URL.");
        std::process::exit(1);
    }
    if let Err(err) = validate_setup_runtime(&runtime, &endpoint) {
        eprintln!("Setup failed: {}", err);
        if runtime_requires_endpoint(&runtime) {
            eprintln!(
                "Re-run `bridges setup --guided` or pass --endpoint http://<LOCAL_RUNTIME_HOST>:<PORT>."
            );
        }
        std::process::exit(1);
    }

    let (_signing_key, verifying_key) = load_identity_or_exit();
    let node_id = identity::derive_node_id(&verifying_key);
    println!("Node ID: {}", node_id);
    if let Some(ref dn) = display_name {
        println!("Name: {}", dn);
    }
    println!("Runtime: {}", runtime);
    if !endpoint.trim().is_empty() {
        println!("Runtime endpoint: {}", endpoint);
    }

    println!("\nRegistering with {}...", coordination);
    cmd_register(&coordination, display_name.as_deref());

    let cfg = DaemonConfig {
        coordination_url: coordination.to_string(),
        runtime: runtime.to_string(),
        runtime_endpoint: endpoint.to_string(),
        ..DaemonConfig::default()
    };
    let cfg_path = cfg.save().unwrap_or_else(|err| {
        eprintln!("Failed to save daemon config: {}", err);
        std::process::exit(1);
    });
    println!("\nConfig written to {}", cfg_path.display());

    println!("\nVerifying local setup...");
    let service_check = match crate::service::service_install() {
        Ok(msg) => DoctorCheck::ok("service", msg),
        Err(err) => DoctorCheck::warn(
            "service",
            format!("service install failed: {}", err),
            vec![
                "You can still run `bridges daemon --foreground` manually.".to_string(),
                "After the daemon is up, run `bridges doctor` for a full diagnostic report."
                    .to_string(),
            ],
        ),
    };
    print_check(&service_check);

    let daemon_check = match wait_for_daemon_status(cfg.local_api_port, std::time::Duration::from_secs(8)) {
        Ok(status) if status.healthy => DoctorCheck::ok(
            "daemon health",
            format!(
                "daemon responding on http://127.0.0.1:{}/status (coordination={:?}, runtime={:?}, reachability={:?})",
                cfg.local_api_port,
                status.coordination.state,
                status.runtime.state,
                status.reachability.mode
            ),
        ),
        Ok(status) => DoctorCheck::warn(
            "daemon health",
            format!(
                "daemon responded but reported degraded state (coordination={:?}, runtime={:?}, reachability={:?})",
                status.coordination.state, status.runtime.state, status.reachability.mode
            ),
            vec![
                "Run `bridges doctor` to inspect the degraded components in more detail.".to_string(),
            ],
        ),
        Err(err) => DoctorCheck::warn(
            "daemon health",
            format!("could not confirm daemon readiness: {}", err),
            vec![
                "Run `bridges service status` to inspect the service manager output.".to_string(),
                "If needed, start the daemon manually with `bridges daemon --foreground`.".to_string(),
            ],
        ),
    };
    print_check(&daemon_check);

    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let skill_check = skill_install_check(&runtime, &cwd);
    print_check(&skill_check);

    println!("\n=== Setup Complete ===");
    println!("  node:    {}", node_id);
    println!("  runtime: {}", runtime);
    println!("  server:  {}", coordination);
    println!("  daemon:  http://127.0.0.1:{}/status", cfg.local_api_port);
    println!("\nNext steps:");
    println!("  bridges doctor                    # full local diagnostics");
    println!("  bridges create my-project         # create a project");
    println!("  bridges invite -p <id>            # invite collaborators");
    println!("  bridges ask owner \"hi\" -p <id>   # talk to a peer");
}

#[derive(Debug, Clone)]
struct RegisteredNode {
    node_id: String,
    api_key: String,
}

fn register_node_with_verifying_key(
    coordination: &str,
    verifying_key: &ed25519_dalek::VerifyingKey,
    display_name: Option<&str>,
) -> Result<RegisteredNode, String> {
    let node_id = identity::derive_node_id(verifying_key);
    let ed_pub = bs58::encode(verifying_key.as_bytes()).into_string();
    let x_pub = hex::encode(
        crate::crypto::ed25519_to_x25519_public(verifying_key.as_bytes())
            .map_err(|err| format!("derive X25519 public key: {}", err))?,
    );
    let name = display_name.unwrap_or(&node_id);

    let client = reqwest::blocking::Client::new();
    let body = serde_json::json!({
        "nodeId": node_id,
        "ed25519Pubkey": ed_pub,
        "x25519Pubkey": x_pub,
        "displayName": name,
    });

    let url = format!("{}/v1/auth/register", coordination.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|err| format!("reach coordination server: {}", err))?;

    if !resp.status().is_success() {
        return Err(format!("registration failed: HTTP {}", resp.status()));
    }

    let val = resp
        .json::<serde_json::Value>()
        .map_err(|err| format!("parse registration response: {}", err))?;
    let api_key = val["apiKey"]
        .as_str()
        .ok_or_else(|| "server response missing apiKey field".to_string())?
        .to_string();

    Ok(RegisteredNode { api_key, node_id })
}

/// Register with a coordination server and save config.
pub fn cmd_register(coordination: &str, display_name: Option<&str>) {
    let (_signing_key, verifying_key) = load_identity_or_exit();
    let name = display_name
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| identity::derive_node_id(&verifying_key));
    let registered = register_node_with_verifying_key(coordination, &verifying_key, Some(&name))
        .unwrap_or_else(|err| {
            eprintln!("Failed to register node: {}", err);
            std::process::exit(1);
        });

    let cfg = ClientConfig {
        coordination: coordination.to_string(),
        node_id: registered.node_id.clone(),
        api_key: registered.api_key,
        display_name: Some(name),
        owner: None,
    };
    cfg.save().unwrap_or_else(|err| {
        eprintln!("Failed to save client config: {}", err);
        std::process::exit(1);
    });
    println!("Registered as {}", registered.node_id);
    println!("Config saved to ~/.bridges/config.json");
}

/// Create a project on the coordination server + local directory.
pub fn cmd_create(name: &str, description: Option<&str>) {
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let body = serde_json::json!({
        "slug": name,
        "displayName": name,
        "description": description,
    });
    let url = format!("{}/v1/projects", cfg.coordination);
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        if resp.status().as_u16() == 409 {
            eprintln!(
                "Project '{}' already exists. Use a different name, or invite collaborators with:",
                name
            );
            eprintln!("  bridges invite -p <project_id>");
            eprintln!("Run 'bridges status' to see your existing projects.");
        } else {
            eprintln!("Create failed: HTTP {}", resp.status());
        }
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let project_id = val["projectId"].as_str().unwrap_or("?");

    // Create local project directory at ~/bridges-projects/<slug>/
    let project_dir = crate::queries::project_dir_for_slug(name);
    std::fs::create_dir_all(&project_dir).ok();

    // Initialize local workspace metadata and optional shared workspace files.
    crate::workspace::init_workspace(&project_dir, name).unwrap_or_else(|err| {
        eprintln!("Failed to initialize workspace: {}", err);
        std::process::exit(1);
    });
    crate::sync_engine::init_shared(&project_dir);

    // Store in local DB with path
    let conn = open_local_db_or_exit();
    crate::queries::insert_project(
        &conn,
        &crate::models::Project {
            project_id: project_id.to_string(),
            slug: name.to_string(),
            display_name: Some(name.to_string()),
            description: description.map(|d| d.to_string()),
            project_path: Some(project_dir.to_string_lossy().to_string()),
            owner_principal_id: None,
            status: "active".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Write initial MEMBERS.md (creator as owner)
    let now = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let (_, vk) = load_identity_or_exit();
    let my_node = identity::derive_node_id(&vk);
    crate::sync_engine::update_members(&project_dir, &[(my_node, "owner".to_string(), now)]);

    println!("Project created: {}", project_id);
    println!("  path: {}", project_dir.display());
}

/// Generate a shareable invite for a project.
pub fn cmd_invite(project_id: &str) {
    require_project_id(project_id);
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/projects/{}/invites", cfg.coordination, project_id);
    let body = serde_json::json!({ "maxUses": 10 });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        eprintln!("Invite failed: HTTP {} — {}", status, text);
        eprintln!("URL: {}", url);
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let invite_token = val["inviteToken"].as_str().unwrap_or("?");
    let shareable = encode_shareable_invite(&cfg.coordination, project_id, invite_token)
        .unwrap_or_else(|err| {
            eprintln!("Failed to build shareable invite: {}", err);
            std::process::exit(1);
        });

    println!("Invite created for {}", project_id);
    println!("\nShare this with your collaborator:");
    println!("  {}", shareable);
    println!("\nJoin command:");
    println!("  bridges join '{}'", shareable);
    println!("\nUnderlying token flow (still supported):");
    println!("  project: {}", project_id);
    println!("  token:   {}", invite_token);
}

/// Join a project with a shareable invite string or raw token + project.
pub fn cmd_join(invite: &str, project_id: Option<&str>) {
    let invite = resolve_join_invite(invite, project_id).unwrap_or_else(|err| {
        eprintln!("Join failed: {}", err);
        std::process::exit(1);
    });
    require_project_id(&invite.project_id);

    let cfg = match ClientConfig::load() {
        Ok(Some(cfg)) => cfg,
        Ok(None) => {
            if let Some(coordination) = invite.coordination.as_deref() {
                eprintln!(
                    "Not registered. Run `bridges setup --coordination {}` before joining this invite.",
                    coordination
                );
            } else {
                eprintln!(
                    "Not registered. Run `bridges setup --coordination <url>` before joining this invite."
                );
            }
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Failed to load client config: {}", err);
            std::process::exit(1);
        }
    };

    if let Some(coordination) = invite.coordination.as_deref() {
        if cfg.coordination.trim_end_matches('/') != coordination.trim_end_matches('/') {
            eprintln!(
                "Join failed: invite targets coordination {}, but this node is registered against {}.",
                coordination, cfg.coordination
            );
            eprintln!(
                "Run `bridges setup --coordination {}` on the correct server, then retry the invite.",
                coordination
            );
            std::process::exit(1);
        }
    }

    let client = authed_client(&cfg);
    let url = format!(
        "{}/v1/projects/{}/join",
        cfg.coordination, invite.project_id
    );
    let body = serde_json::json!({
        "inviteToken": invite.invite_token,
        "agentRole": "member",
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Join failed: HTTP {}", resp.status());
        std::process::exit(1);
    }

    // Fetch project details to get the slug.
    let details_url = format!("{}/v1/projects/{}", cfg.coordination, invite.project_id);
    let slug = match client.get(&details_url).send() {
        Ok(resp) if resp.status().is_success() => {
            let val: serde_json::Value = resp.json().unwrap_or_default();
            val["slug"]
                .as_str()
                .unwrap_or(&invite.project_id)
                .to_string()
        }
        _ => invite.project_id.replace("proj_", ""),
    };

    // Check if project directory already exists locally
    let conn = open_local_db_or_exit();
    let project_dir = if let Some(existing) = crate::queries::get_project_path_by_slug(&conn, &slug)
    {
        std::path::PathBuf::from(existing)
    } else {
        let dir = crate::queries::project_dir_for_slug(&slug);
        std::fs::create_dir_all(&dir).ok();
        dir
    };

    // Initialize local workspace metadata and optional shared workspace files.
    crate::workspace::init_workspace(&project_dir, &slug).unwrap_or_else(|err| {
        eprintln!("Failed to initialize workspace: {}", err);
        std::process::exit(1);
    });
    crate::sync_engine::init_shared(&project_dir);

    // Store in local DB
    crate::queries::insert_project(
        &conn,
        &crate::models::Project {
            project_id: invite.project_id.to_string(),
            slug: slug.clone(),
            display_name: Some(slug.clone()),
            description: None,
            project_path: Some(project_dir.to_string_lossy().to_string()),
            owner_principal_id: None,
            status: "active".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Fetch and write MEMBERS.md
    let members_url = format!(
        "{}/v1/projects/{}/members",
        cfg.coordination, invite.project_id
    );
    if let Ok(resp) = client.get(&members_url).send() {
        if let Ok(members) = resp.json::<Vec<serde_json::Value>>() {
            let member_list: Vec<(String, String, String)> = members
                .iter()
                .map(|m| {
                    let nid = m["nodeId"].as_str().unwrap_or("?").to_string();
                    let role = m["agentRole"].as_str().unwrap_or("member").to_string();
                    let joined = m["joinedAt"].as_str().unwrap_or("?").to_string();
                    (nid, role, joined)
                })
                .collect();
            crate::sync_engine::update_members(&project_dir, &member_list);
        }
    }

    println!("Joined project {}", invite.project_id);
    println!("  path: {}", project_dir.display());
}

/// List members of a project.
pub fn cmd_members(project_id: &str) {
    require_project_id(project_id);
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/projects/{}/members", cfg.coordination, project_id);
    let resp = send_or_exit(&client, &url, None, "GET");
    if !resp.status().is_success() {
        eprintln!("Members failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let members: Vec<serde_json::Value> = parse_json_or_exit(resp);
    println!("Members of {}:", project_id);
    for m in &members {
        let name = m["displayName"].as_str().unwrap_or("?");
        let role = m["agentRole"].as_str().unwrap_or("member");
        let nid = m["nodeId"].as_str().unwrap_or("?");
        println!("  {} ({}) [{}]", nid, name, role);
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RemoteIdentityStatus {
    #[serde(rename = "nodeId")]
    pub(crate) node_id: String,
    #[serde(rename = "revokedAt")]
    pub(crate) revoked_at: Option<String>,
    #[serde(rename = "revocationReason")]
    pub(crate) revocation_reason: Option<String>,
    #[serde(rename = "replacementNodeId")]
    pub(crate) replacement_node_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RemoteReplaceResp {
    #[serde(rename = "oldNodeId")]
    old_node_id: String,
    #[serde(rename = "newNodeId")]
    new_node_id: String,
    #[serde(rename = "migratedProjectCount")]
    migrated_project_count: i64,
}

pub(crate) fn fetch_remote_identity_status(
    cfg: &ClientConfig,
) -> Result<RemoteIdentityStatus, String> {
    let client = authed_client(cfg);
    let url = format!("{}/v1/auth/me", cfg.coordination);
    let resp = client
        .get(&url)
        .send()
        .map_err(|err| format!("identity status request failed: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!("identity status returned HTTP {}", resp.status()));
    }
    resp.json::<RemoteIdentityStatus>()
        .map_err(|err| format!("failed to parse identity status response: {}", err))
}

fn doctor_identity_check(cfg: &ClientConfig, remote: &RemoteIdentityStatus) -> DoctorCheck {
    if remote.node_id != cfg.node_id {
        return DoctorCheck::error(
            "identity lifecycle",
            format!(
                "local config node {} does not match coordination node {}",
                cfg.node_id, remote.node_id
            ),
            vec![
                "This usually means local identity/config drift after a rotation or partial restore."
                    .to_string(),
                "Run `bridges identity status` and re-run setup or rotation recovery before sending messages."
                    .to_string(),
            ],
        );
    }

    if let Some(revoked_at) = remote.revoked_at.as_deref() {
        let mut hints = vec![
            format!("This node was revoked at {}.", revoked_at),
            "Run `bridges identity rotate` or `bridges setup --coordination <URL>` to establish a new active node."
                .to_string(),
        ];
        if let Some(replacement) = remote.replacement_node_id.as_deref() {
            hints.push(format!(
                "Replacement node recorded by coordination: {}",
                replacement
            ));
        }
        if let Some(reason) = remote.revocation_reason.as_deref() {
            hints.push(format!("Revocation reason: {}", reason));
        }
        return DoctorCheck::error(
            "identity lifecycle",
            format!("coordination reports node {} as revoked", remote.node_id),
            hints,
        );
    }

    DoctorCheck::ok(
        "identity lifecycle",
        format!("coordination reports node {} as active", remote.node_id),
    )
}

pub fn cmd_identity_status() {
    let cfg = ClientConfig::load_or_exit();
    let remote = fetch_remote_identity_status(&cfg).unwrap_or_else(|err| {
        eprintln!("Identity status failed: {}", err);
        std::process::exit(1);
    });

    println!("Current identity:");
    println!("  local node:      {}", cfg.node_id);
    println!("  remote node:     {}", remote.node_id);
    println!("  coordination:    {}", cfg.coordination);
    println!(
        "  display name:    {}",
        cfg.display_name.as_deref().unwrap_or("(none)")
    );
    match remote.revoked_at.as_deref() {
        Some(revoked_at) => {
            println!("  lifecycle state: revoked");
            println!("  revoked at:      {}", revoked_at);
            if let Some(reason) = remote.revocation_reason.as_deref() {
                println!("  revoke reason:   {}", reason);
            }
            if let Some(replacement) = remote.replacement_node_id.as_deref() {
                println!("  replacement:     {}", replacement);
            }
        }
        None => println!("  lifecycle state: active"),
    }
}

pub fn cmd_identity_revoke(reason: Option<&str>) {
    let mut cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/auth/revoke", cfg.coordination);
    let body = serde_json::json!({
        "reason": reason,
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Identity revoke failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let remote: RemoteIdentityStatus = parse_json_or_exit(resp);
    cfg.api_key.clear();
    cfg.save().unwrap_or_else(|err| {
        eprintln!(
            "Failed to update local client config after revocation: {}",
            err
        );
        std::process::exit(1);
    });

    println!("Revoked node {}", remote.node_id);
    if let Some(revoked_at) = remote.revoked_at.as_deref() {
        println!("  revoked at: {}", revoked_at);
    }
    if let Ok(message) = crate::service::service_restart() {
        println!("  service: {}", message);
    }
    println!("Local API key was cleared. Run `bridges setup` or `bridges identity rotate` before using this node again.");
}

pub fn cmd_identity_rotate() {
    let mut cfg = ClientConfig::load_or_exit();
    let display_name = cfg.display_name.clone();
    let (_old_signing, old_verifying) = load_identity_or_exit();
    let old_node_id = identity::derive_node_id(&old_verifying);

    println!("Generating replacement identity for {}...", old_node_id);
    let (new_signing, new_verifying) = identity::generate_ephemeral_keypair();
    let replacement = register_node_with_verifying_key(
        &cfg.coordination,
        &new_verifying,
        display_name.as_deref(),
    )
    .unwrap_or_else(|err| {
        eprintln!("Failed to register replacement node: {}", err);
        std::process::exit(1);
    });

    let client = authed_client(&cfg);
    let url = format!("{}/v1/auth/replace", cfg.coordination);
    let body = serde_json::json!({
        "newNodeId": replacement.node_id,
        "newApiKey": replacement.api_key,
        "reason": "rotated_locally",
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Identity rotate failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let replaced: RemoteReplaceResp = parse_json_or_exit(resp);

    identity::replace_keypair(&new_signing).unwrap_or_else(|err| {
        eprintln!("Failed to persist replacement identity: {}", err);
        std::process::exit(1);
    });
    cfg.node_id = replacement.node_id.clone();
    cfg.api_key = replacement.api_key;
    cfg.save().unwrap_or_else(|err| {
        eprintln!("Failed to save rotated client config: {}", err);
        std::process::exit(1);
    });

    println!("Identity rotated successfully");
    println!("  old node: {}", replaced.old_node_id);
    println!("  new node: {}", replaced.new_node_id);
    println!("  migrated projects: {}", replaced.migrated_project_count);
    match crate::service::service_restart() {
        Ok(message) => println!("  service: {}", message),
        Err(err) => eprintln!("  Service restart failed: {}", err),
    }
    println!("Run `bridges doctor` to confirm the replacement node is healthy.");
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
        match fetch_remote_identity_status(cfg) {
            Ok(remote) => checks.push(doctor_identity_check(cfg, &remote)),
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
    fn shareable_invite_round_trips() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080/", "proj_test", "bridges_inv_test")
                .unwrap();
        let decoded = decode_shareable_invite(&encoded).unwrap().unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.coordination, "http://127.0.0.1:17080");
        assert_eq!(decoded.project_id, "proj_test");
        assert_eq!(decoded.invite_token, "bridges_inv_test");
    }

    #[test]
    fn resolve_join_invite_accepts_shareable_string_without_project_flag() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080", "proj_test", "bridges_inv_test")
                .unwrap();
        let invite = resolve_join_invite(&encoded, None).unwrap();
        assert_eq!(invite.project_id, "proj_test");
        assert_eq!(invite.invite_token, "bridges_inv_test");
        assert_eq!(
            invite.coordination.as_deref(),
            Some("http://127.0.0.1:17080")
        );
    }

    #[test]
    fn resolve_join_invite_rejects_mismatched_project_flag() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080", "proj_test", "bridges_inv_test")
                .unwrap();
        let err = resolve_join_invite(&encoded, Some("proj_other")).unwrap_err();
        assert!(err.contains("targets project proj_test"));
    }

    #[test]
    fn resolve_join_invite_requires_project_for_raw_token() {
        let err = resolve_join_invite("bridges_inv_test", None).unwrap_err();
        assert!(err.contains("raw invite tokens still require --project"));
    }

    #[test]
    fn doctor_identity_check_reports_revoked_node_as_error() {
        let cfg = ClientConfig {
            coordination: "http://127.0.0.1:17080".to_string(),
            node_id: "kd_old".to_string(),
            api_key: "bridges_sk_test".to_string(),
            display_name: Some("node".to_string()),
            owner: None,
        };
        let remote = RemoteIdentityStatus {
            node_id: "kd_old".to_string(),
            revoked_at: Some("2026-04-17T00:00:00Z".to_string()),
            revocation_reason: Some("compromised".to_string()),
            replacement_node_id: Some("kd_new".to_string()),
        };

        let check = doctor_identity_check(&cfg, &remote);
        assert_eq!(check.level, DoctorLevel::Error);
        assert!(check.summary.contains("revoked"));
        assert!(check.hints.iter().any(|hint| hint.contains("kd_new")));
    }

    #[test]
    fn preferred_runtime_uses_existing_supported_runtime() {
        let candidates = vec![
            RuntimeCandidate {
                name: "claude-code",
                description: "",
                detected: true,
                detection_hint: "detected".to_string(),
            },
            RuntimeCandidate {
                name: "codex",
                description: "",
                detected: true,
                detection_hint: "detected".to_string(),
            },
        ];

        assert_eq!(preferred_runtime(Some("codex"), &candidates), "codex");
    }

    #[test]
    fn preferred_runtime_falls_back_to_detected_cli_runtime() {
        let candidates = vec![
            RuntimeCandidate {
                name: "claude-code",
                description: "",
                detected: false,
                detection_hint: "missing".to_string(),
            },
            RuntimeCandidate {
                name: "codex",
                description: "",
                detected: true,
                detection_hint: "detected".to_string(),
            },
            RuntimeCandidate {
                name: "generic",
                description: "",
                detected: false,
                detection_hint: "manual".to_string(),
            },
        ];

        assert_eq!(preferred_runtime(None, &candidates), "codex");
    }

    #[test]
    fn validate_setup_runtime_requires_endpoint_for_http_runtime() {
        let err = validate_setup_runtime("generic", "").unwrap_err();
        assert!(err.contains("requires --endpoint"));
    }

    #[test]
    fn skill_destination_for_codex_uses_home_skill_dir() {
        let cwd = std::path::Path::new("/tmp/workspace");
        let home = std::path::Path::new("/home/tester");
        let path = skill_destination_for_runtime("codex", cwd, Some(home)).unwrap();
        assert_eq!(
            path,
            std::path::PathBuf::from("/home/tester/.codex/skills/bridges")
        );
    }

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
