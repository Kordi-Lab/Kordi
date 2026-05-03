use crate::client_config::ClientConfig;
use crate::config::DaemonConfig;
use crate::identity;

use super::{cmd_register, load_identity_or_exit, print_check, DoctorCheck};

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
    cmd_register(&coordination, display_name.as_deref(), Some(&runtime));

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
