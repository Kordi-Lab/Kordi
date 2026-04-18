mod client_config;
mod commands;
mod config;
mod connmgr;
mod conversation_memory;
mod coord_client;
mod crypto;
mod daemon;
mod db;
mod derp_client;
mod error;
mod identity;
mod listener;
mod local_api;
mod mdns;
mod models;
mod noise;
mod permissions;
mod presence;
mod queries;
mod serve;
mod service;
mod stun;
mod sync_engine;
mod transport;
mod workspace;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "bridges",
    version,
    about = "Bridges — peer-to-peer Human Agent Network"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new Bridges workspace in the current or given directory
    Init {
        #[arg(short, long)]
        slug: Option<String>,
        #[arg(short, long)]
        path: Option<PathBuf>,
    },
    /// Start the Bridges daemon (encrypted P2P networking + listener)
    Daemon {
        #[arg(long, default_value = "true")]
        foreground: bool,
    },
    /// Manage the background daemon service
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Set up a local Bridges node, with guided onboarding when key flags are omitted
    Setup {
        /// Coordination server URL. If omitted, setup will prompt interactively.
        #[arg(long)]
        coordination: Option<String>,
        /// Runtime type (claude-code, codex, openclaw, generic). If omitted, Bridges will detect or prompt.
        #[arg(long)]
        runtime: Option<String>,
        /// Runtime endpoint URL (required for openclaw/generic)
        #[arg(long)]
        endpoint: Option<String>,
        /// Your display name
        #[arg(long)]
        name: Option<String>,
        /// Force the guided onboarding flow even when flags are provided
        #[arg(long, default_value_t = false)]
        guided: bool,
    },
    /// Optionally sync shared workspace files for a project
    Sync {
        /// Project ID (auto-resolves path)
        #[arg(short, long)]
        project: Option<String>,
        /// Override project path
        #[arg(long)]
        path: Option<PathBuf>,
        /// Approve syncing unmanaged paths after reviewing the generated proposal
        #[arg(long, default_value_t = false)]
        approve_unmanaged: bool,
    },
    /// Show node identity and project status
    Status,
    /// Manage local identity lifecycle
    Identity {
        #[command(subcommand)]
        action: IdentityAction,
    },
    /// Run local diagnostics for daemon, coordination, runtime, project, and peer state
    Doctor {
        /// Optional project ID for project-scoped diagnostics
        #[arg(long)]
        project: Option<String>,
        /// Optional peer selector (node ID, display name, `owner`, or `role:<role>`)
        #[arg(long)]
        peer: Option<String>,
    },
    /// Ping a peer to test encrypted connectivity
    Ping {
        /// Node ID to ping (kd_xxx)
        node_id: String,
    },

    // ── Coordination commands ──
    /// Run the coordination server
    Serve {
        #[arg(short, long, default_value = "17080")]
        port: u16,
        /// Path to server SQLite database
        #[arg(long, default_value = "./bridges-server.db")]
        db: String,
    },
    /// Register with a coordination server
    Register {
        #[arg(long)]
        coordination: String,
    },
    /// Create a project
    Create {
        /// Project name/slug
        name: String,
        #[arg(short, long)]
        description: Option<String>,
    },
    /// Generate a shareable invite for a project
    Invite {
        #[arg(short, long)]
        project: String,
    },
    /// Join a project using a shareable invite string or a raw invite token
    Join {
        /// Shareable invite string (`bridges://join/...`) or raw invite token
        invite: String,
        /// Project ID (required only when using a raw invite token)
        #[arg(short, long)]
        project: Option<String>,
    },
    /// List members of a project
    Members {
        #[arg(short, long)]
        project: String,
    },
    /// Ask another agent a question
    Ask {
        /// Target node ID or project-scoped selector (display name, `owner`, or `role:<role>`)
        node_id: String,
        /// Question text
        question: String,
        /// Project ID (optional — can chat without a project)
        #[arg(short, long, default_value = "")]
        project: String,
        /// Start a new conversation session instead of continuing the active one
        #[arg(long, default_value_t = false)]
        new_session: bool,
    },
    /// Start a debate with all project members
    Debate {
        /// Debate topic
        topic: String,
        #[arg(short, long)]
        project: String,
        /// Start a new conversation session with each peer instead of continuing the active one
        #[arg(long, default_value_t = false)]
        new_session: bool,
    },
    /// Inspect and manage conversation sessions with a peer
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Broadcast a message to all project members
    Broadcast {
        /// Message text
        message: String,
        #[arg(short, long)]
        project: String,
    },
    /// Publish a file as an artifact to project members
    Publish {
        /// File path to publish
        file: String,
        #[arg(short, long)]
        project: String,
    },
}

#[derive(Subcommand)]
enum ServiceAction {
    Install,
    Uninstall,
    Start,
    Stop,
    Restart,
    Status,
}

#[derive(Subcommand)]
enum IdentityAction {
    /// Show current identity and registration state
    Status,
    /// Replace the current node with a freshly generated identity and migrate memberships
    Rotate,
    /// Revoke the current node identity
    Revoke {
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    /// List sessions for a peer in a project
    List {
        #[arg(short, long)]
        project: String,
        #[arg(long)]
        peer: String,
    },
    /// Start a fresh session and make it active
    New {
        #[arg(short, long)]
        project: String,
        #[arg(long)]
        peer: String,
    },
    /// Switch the active session for a peer
    Use {
        session_id: String,
        #[arg(short, long)]
        project: String,
        #[arg(long)]
        peer: String,
    },
    /// Reset one session or all sessions for a peer
    Reset {
        #[arg(short, long)]
        project: String,
        #[arg(long)]
        peer: String,
        #[arg(long)]
        session: Option<String>,
        #[arg(long, default_value_t = false)]
        all: bool,
    },
}

fn open_local_db_or_exit() -> rusqlite::Connection {
    let conn = db::open_db().unwrap_or_else(|err| {
        eprintln!("Failed to open local database: {}", err);
        std::process::exit(1);
    });
    db::init_db(&conn).unwrap_or_else(|err| {
        eprintln!("Failed to initialize local database: {}", err);
        std::process::exit(1);
    });
    conn
}

fn load_identity_or_exit() -> (ed25519_dalek::SigningKey, ed25519_dalek::VerifyingKey) {
    identity::load_or_create_keypair().unwrap_or_else(|err| {
        eprintln!("Failed to load identity: {}", err);
        std::process::exit(1);
    })
}

fn build_runtime_or_exit() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build tokio runtime: {}", err);
            std::process::exit(1);
        })
}

/// Entry point — most commands run without tokio (blocking HTTP).
/// Only daemon, serve, sync, and ping need the async runtime.
fn main() {
    let cli = Cli::parse();

    match cli.command {
        // ── Sync commands (no tokio, instant startup) ──
        Commands::Status => {
            let conn = open_local_db_or_exit();
            drop(conn);
            let (_signing_key, verifying_key) = load_identity_or_exit();
            let node_id = identity::derive_node_id(&verifying_key);
            cmd_status(&node_id, &verifying_key);
        }
        Commands::Init { slug, path } => {
            let conn = open_local_db_or_exit();
            drop(conn);
            let (signing_key, verifying_key) = load_identity_or_exit();
            let node_id = identity::derive_node_id(&verifying_key);
            cmd_init(&node_id, &signing_key, slug, path);
        }
        Commands::Doctor { project, peer } => {
            commands::cmd_doctor(project.as_deref(), peer.as_deref());
        }
        Commands::Identity { action } => match action {
            IdentityAction::Status => commands::cmd_identity_status(),
            IdentityAction::Rotate => commands::cmd_identity_rotate(),
            IdentityAction::Revoke { reason } => {
                commands::cmd_identity_revoke(reason.as_deref());
            }
        },
        Commands::Register { coordination } => {
            commands::cmd_register(&coordination, None);
        }
        Commands::Setup {
            coordination,
            runtime,
            endpoint,
            name,
            guided,
        } => {
            commands::cmd_setup(
                coordination.as_deref(),
                runtime.as_deref(),
                endpoint.as_deref(),
                name.as_deref(),
                guided,
            );
        }
        Commands::Create { name, description } => {
            commands::cmd_create(&name, description.as_deref());
        }
        Commands::Invite { project } => {
            commands::cmd_invite(&project);
        }
        Commands::Join { invite, project } => {
            commands::cmd_join(&invite, project.as_deref());
        }
        Commands::Members { project } => {
            commands::cmd_members(&project);
        }
        Commands::Ask {
            node_id,
            question,
            project,
            new_session,
        } => {
            let proj = if project.is_empty() {
                None
            } else {
                Some(project.as_str())
            };
            commands::cmd_ask(&node_id, &question, proj, new_session);
        }
        Commands::Debate {
            topic,
            project,
            new_session,
        } => {
            commands::cmd_debate(&topic, &project, new_session);
        }
        Commands::Session { action } => match action {
            SessionAction::List { project, peer } => {
                commands::cmd_session_list(&project, &peer);
            }
            SessionAction::New { project, peer } => {
                commands::cmd_session_new(&project, &peer);
            }
            SessionAction::Use {
                session_id,
                project,
                peer,
            } => {
                commands::cmd_session_use(&project, &peer, &session_id);
            }
            SessionAction::Reset {
                project,
                peer,
                session,
                all,
            } => {
                commands::cmd_session_reset(&project, &peer, session.as_deref(), all);
            }
        },
        Commands::Broadcast { message, project } => {
            commands::cmd_broadcast(&message, &project);
        }
        Commands::Publish { file, project } => {
            commands::cmd_publish(&file, &project);
        }
        Commands::Service { action } => match action {
            ServiceAction::Install => match service::service_install() {
                Ok(msg) => println!("{}", msg),
                Err(e) => {
                    eprintln!("Service install failed: {}", e);
                    std::process::exit(1);
                }
            },
            ServiceAction::Uninstall => match service::service_uninstall() {
                Ok(msg) => println!("{}", msg),
                Err(e) => {
                    eprintln!("Service uninstall failed: {}", e);
                    std::process::exit(1);
                }
            },
            ServiceAction::Start => match service::service_start() {
                Ok(msg) => println!("{}", msg),
                Err(e) => {
                    eprintln!("Service start failed: {}", e);
                    std::process::exit(1);
                }
            },
            ServiceAction::Stop => match service::service_stop() {
                Ok(msg) => println!("{}", msg),
                Err(e) => {
                    eprintln!("Service stop failed: {}", e);
                    std::process::exit(1);
                }
            },
            ServiceAction::Restart => match service::service_restart() {
                Ok(msg) => println!("{}", msg),
                Err(e) => {
                    eprintln!("Service restart failed: {}", e);
                    std::process::exit(1);
                }
            },
            ServiceAction::Status => match service::service_status() {
                Ok(status) => println!("{}", status),
                Err(e) => {
                    eprintln!("Service status failed: {}", e);
                    std::process::exit(1);
                }
            },
        },
        // ── Async commands (need tokio for long-running networking) ──
        Commands::Serve { port, db } => {
            build_runtime_or_exit().block_on(async {
                if let Err(e) = serve::run(port, &db).await {
                    eprintln!("Server error: {}", e);
                }
            });
        }
        Commands::Daemon { foreground } => {
            build_runtime_or_exit().block_on(async {
                if let Err(e) = daemon::run(foreground).await {
                    eprintln!("Daemon error: {}", e);
                }
            });
        }
        Commands::Sync {
            project,
            path,
            approve_unmanaged,
        } => {
            let conn = open_local_db_or_exit();

            let project_dir = if let Some(pid) = &project {
                queries::get_project_path(&conn, pid)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        eprintln!("Project {} not found locally", pid);
                        std::process::exit(1);
                    })
            } else if let Some(p) = path {
                p
            } else {
                eprintln!("Specify --project <ID> or --path <DIR>");
                std::process::exit(1);
            };
            drop(conn);

            let (_, verifying_key) = load_identity_or_exit();
            let node_id = identity::derive_node_id(&verifying_key);

            sync_engine::init_shared(&project_dir);
            match sync_engine::sync_project(&project_dir, &node_id, approve_unmanaged) {
                Ok(result) => {
                    if result.pushed {
                        println!("Pushed local changes");
                    }
                    if result.pulled > 0 {
                        println!("Pulled {} changes", result.pulled);
                    }
                    if result.pulled == 0 && !result.pushed {
                        println!("Already up to date");
                    }
                    if !result.conflicts.is_empty() {
                        println!("CONFLICTS: {}", result.conflicts.join(", "));
                        println!("Resolve conflicts in shared workspace files, then sync again");
                    }
                    for warning in &result.warnings {
                        println!("SYNC WARNING: {}", warning);
                    }
                }
                Err(e) => eprintln!("Sync failed: {}", e),
            }
        }
        Commands::Ping { node_id } => {
            let conn = open_local_db_or_exit();
            drop(conn);
            let (signing_key, verifying_key) = load_identity_or_exit();
            let my_node_id = identity::derive_node_id(&verifying_key);
            build_runtime_or_exit().block_on(cmd_ping(&my_node_id, &signing_key, &node_id));
        }
    }
}

fn cmd_init(
    node_id: &str,
    signing_key: &ed25519_dalek::SigningKey,
    slug: Option<String>,
    path: Option<PathBuf>,
) {
    let project_path = path.unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|err| {
            eprintln!("Failed to resolve current directory: {}", err);
            std::process::exit(1);
        })
    });
    let slug = slug.unwrap_or_else(|| {
        project_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project")
            .to_string()
    });

    workspace::init_workspace(&project_path, &slug).unwrap_or_else(|err| {
        eprintln!("Failed to initialize workspace: {}", err);
        std::process::exit(1);
    });

    if let Some(pj) = workspace::read_project_json(&project_path).unwrap_or_else(|err| {
        eprintln!("Failed to read workspace metadata: {}", err);
        std::process::exit(1);
    }) {
        let conn = open_local_db_or_exit();
        let verifying = signing_key.verifying_key();
        let pubkey_b58 = bs58::encode(verifying.as_bytes()).into_string();

        queries::insert_node(
            &conn,
            &models::Node {
                node_id: node_id.to_string(),
                display_name: Some(slug.clone()),
                runtime: Some("bridges-cli".to_string()),
                endpoint: None,
                public_key: pubkey_b58,
                owner_principal_id: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            },
        );

        queries::insert_project(
            &conn,
            &models::Project {
                project_id: pj.project_id.clone(),
                slug: pj.slug.clone(),
                display_name: Some(pj.display_name.clone()),
                description: None,
                project_path: Some(project_path.to_string_lossy().to_string()),
                owner_principal_id: None,
                status: "active".to_string(),
                created_at: pj.created_at.clone(),
            },
        );

        println!("Initialized Bridges workspace:");
        println!("  node:    {}", node_id);
        println!("  project: {} ({})", pj.slug, pj.project_id);
        println!("  path:    {}", project_path.display());
    }
}

fn cmd_status(node_id: &str, verifying_key: &ed25519_dalek::VerifyingKey) {
    let pubkey_b58 = bs58::encode(verifying_key.as_bytes()).into_string();
    let x25519_pub =
        crypto::ed25519_to_x25519_public(verifying_key.as_bytes()).unwrap_or_else(|err| {
            eprintln!("Failed to derive X25519 public key: {}", err);
            std::process::exit(1);
        });

    println!("Bridges Node Status");
    println!("  node_id:      {}", node_id);
    println!("  ed25519_pub:  {}", pubkey_b58);
    println!("  x25519_pub:   {}", hex::encode(x25519_pub));

    let daemon_cfg = config::DaemonConfig::load().unwrap_or_default();

    // Show client config if available.
    match client_config::ClientConfig::load() {
        Ok(Some(cfg)) if !cfg.api_key.trim().is_empty() => {
            println!("  coordination: {}", cfg.coordination);
            println!("  registered:   yes");
            match commands::fetch_remote_identity_status(&cfg) {
                Ok(remote) => {
                    if remote.node_id != cfg.node_id {
                        println!(
                            "  lifecycle:    config mismatch (local={} remote={})",
                            cfg.node_id, remote.node_id
                        );
                    } else if let Some(revoked_at) = remote.revoked_at.as_deref() {
                        println!("  lifecycle:    revoked at {}", revoked_at);
                        if let Some(reason) = remote.revocation_reason.as_deref() {
                            println!("  revoke reason: {}", reason);
                        }
                        if let Some(replacement) = remote.replacement_node_id.as_deref() {
                            println!("  replacement:  {}", replacement);
                        }
                    } else {
                        println!("  lifecycle:    active");
                    }
                }
                Err(err) => {
                    println!("  lifecycle:    error ({})", err);
                }
            }
        }
        Ok(Some(_)) => {
            println!("  registered:   no");
            println!("  lifecycle:    local API key is empty (node likely revoked or not fully configured)");
        }
        Ok(None) => {
            println!("  registered:   no");
        }
        Err(err) => {
            println!("  registered:   error");
            println!("  config error: {}", err);
        }
    }

    let daemon_status = build_runtime_or_exit().block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| format!("build client: {}", e))?;
        let url = format!("http://127.0.0.1:{}/status", daemon_cfg.local_api_port);
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("daemon unreachable: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("daemon returned {}", resp.status()));
        }
        resp.json::<local_api::StatusResponse>()
            .await
            .map_err(|e| format!("parse daemon status: {}", e))
    });

    match daemon_status {
        Ok(status) => {
            println!("  daemon:       {}", status.daemon.state);
            println!("  started_at:   {}", status.daemon.started_at);
            println!(
                "  coordination: {:?}{}",
                status.coordination.state,
                status
                    .coordination
                    .detail
                    .as_deref()
                    .map(|detail| format!(" ({})", detail))
                    .unwrap_or_default()
            );
            println!(
                "  runtime:      {:?}{}",
                status.runtime.state,
                status
                    .runtime
                    .detail
                    .as_deref()
                    .map(|detail| format!(" ({})", detail))
                    .unwrap_or_default()
            );
            println!(
                "  reachability: {:?} (endpoint_hints={}, derp_connected={}, mailbox_durable={})",
                status.reachability.mode,
                status.reachability.endpoint_hints_published,
                status.reachability.derp_connected,
                status.reachability.mailbox_durable
            );
        }
        Err(err) => {
            println!("  daemon:       offline ({})", err);
        }
    }

    let conn = open_local_db_or_exit();

    let projects = queries::list_projects(&conn);
    if projects.is_empty() {
        println!("  projects:     (none)");
    } else {
        println!("  projects:");
        for p in &projects {
            let path = p.project_path.as_deref().unwrap_or("?");
            println!("    - {} [{}] {}", p.slug, p.status, p.project_id);
            println!("      path: {}", path);
        }
    }

    let peers = queries::list_peers(&conn);
    if peers.is_empty() {
        println!("  peers:        (none)");
    } else {
        println!("  peers:");
        for peer in &peers {
            let name = peer.display_name.as_deref().unwrap_or("?");
            println!("    - {} ({}) [{}]", peer.node_id, name, peer.trust_status);
        }
    }
}

async fn cmd_ping(node_id: &str, _signing_key: &ed25519_dalek::SigningKey, target: &str) {
    println!("Pinging {} ...", target);

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "peer_id": target,
        "message": format!("ping from {}", node_id),
    });

    match client
        .post("http://127.0.0.1:7070/send")
        .json(&body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            println!("  ping sent via daemon (encrypted)");
        }
        Ok(resp) => {
            eprintln!("  daemon returned {}", resp.status());
        }
        Err(_) => {
            eprintln!("  daemon not running (start with: bridges daemon)");
        }
    }
}
