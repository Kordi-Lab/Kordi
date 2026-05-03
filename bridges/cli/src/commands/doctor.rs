use crate::client_config::ClientConfig;
use crate::config::DaemonConfig;
use crate::identity;

use super::{
    daemon_url, identity_commands, resolve_member_selector, resolve_project_dir,
    try_fetch_project_members_json, AddressableMember, DoctorCheck, DoctorLevel,
};

fn doctor_service_check_from_status(status: &str) -> DoctorCheck {
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("active") || normalized.contains("running") {
        DoctorCheck::ok(
            "service",
            format!("daemon service reports: {}", status.trim()),
        )
    } else {
        DoctorCheck::warn(
            "service",
            format!("daemon service is not clearly running: {}", status.trim()),
            vec![
                "Run `bridges service status` for the raw service manager output.".to_string(),
                "If needed, run `bridges service start` or `bridges daemon --foreground`."
                    .to_string(),
            ],
        )
    }
}

fn doctor_service_check() -> DoctorCheck {
    match crate::service::service_status() {
        Ok(status) => doctor_service_check_from_status(&status),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_service_check_marks_running_status_as_ok() {
        let check = doctor_service_check_from_status("Active: active (running)");
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
