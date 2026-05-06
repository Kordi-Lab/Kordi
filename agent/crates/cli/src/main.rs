use std::collections::BTreeMap;

use anyhow::Result;
use clap::{Parser, Subcommand};

mod agents_md;
mod compaction_exec;
mod extensions;

mod input_files;
mod live_models;
mod login;
mod models;
mod oauth;
mod reflection_runtime;
mod run;
mod runtime_model;
mod session_bootstrap;
mod session_info;
mod session_navigation;
mod slash;
mod task_operator;
mod tool_registry;
mod tui;
mod turn_runner;
mod update_check;

#[derive(Parser)]
#[command(
    name = "kordi",
    about = "Kordi - a Rust-native coding agent",
    version,
    after_help = r#"Examples:
  kordi                               TUI mode
  kordi "List all .rs files in src/"  TUI with initial prompt
  kordi -p "What is 2+2?"             Print mode (non-interactive)
  kordi -c                            Continue previous session
  kordi -r                            Resume: pick a session
  kordi --model anthropic/claude-sonnet-4-20250514
  kordi --model sonnet:high           Model with thinking level
  kordi --list-models                 List all available models
  kordi --list-models sonnet          Search models
  kordi login                         Login to a provider (OAuth)
  kordi logout                        Logout from a provider
  kordi install npm:kordi-example-skill
  kordi install --local ./my-skill
  kordi list                          List configured package sources
  kordi update                        Update installed package sources"#
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Working directory
    #[arg(short = 'C', long, global = true)]
    cwd: Option<String>,

    /// Provider name (or use --model provider/model)
    #[arg(long)]
    provider: Option<String>,

    /// Model ID or "provider/model" or "model:thinking"
    #[arg(long)]
    model: Option<String>,

    /// API key (defaults to env vars)
    #[arg(long)]
    api_key: Option<String>,

    /// System prompt override (use @filepath to load from file)
    #[arg(long)]
    system_prompt: Option<String>,

    /// Append to system prompt
    #[arg(long)]
    append_system_prompt: Option<String>,

    /// Use a named system prompt template from ~/.kordi/system-prompts/<name>.md
    #[arg(short = 't', long = "template")]
    system_prompt_template: Option<String>,

    /// List available system prompt templates
    #[arg(long)]
    list_templates: bool,

    /// Thinking level: off, low, medium, high
    #[arg(long)]
    thinking: Option<String>,

    /// Non-interactive mode: process prompt and exit
    #[arg(short, long)]
    print: bool,

    /// Continue previous session
    #[arg(short, long)]
    r#continue: bool,

    /// Resume: select a session to continue
    #[arg(short, long)]
    resume: bool,

    /// Don't save session (ephemeral)
    #[arg(long)]
    no_session: bool,

    /// Use specific session file/ID
    #[arg(long)]
    session: Option<String>,

    /// Comma-separated tools to enable (default: read,bash,edit,write)
    #[arg(long)]
    tools: Option<String>,

    /// Disable all tools
    #[arg(long)]
    no_tools: bool,

    /// List available models (with optional search)
    #[arg(long)]
    list_models: Option<Option<String>>,

    /// Models for Ctrl+P cycling (comma-separated patterns)
    #[arg(long)]
    models: Option<String>,

    /// Load a plugin file
    #[arg(short = 'e', long = "extension")]
    extensions: Vec<String>,

    /// Verbose startup
    #[arg(long)]
    verbose: bool,

    /// Initial prompt / messages
    #[arg(trailing_var_arg = true)]
    messages: Vec<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Login to a provider (OAuth / API key)
    Login {
        /// Provider name (anthropic, openai, google, ...)
        provider: Option<String>,
    },
    /// Logout from a provider
    Logout {
        /// Provider name
        provider: Option<String>,
    },
    #[command(after_help = r#"Examples:
  kordi install npm:kordi-example-skill
  kordi install --local npm:my-project-skill
  kordi install --local ./my-skill
  kordi install git:https://github.com/org/repo.git
  kordi install https://example.com/package.tar.gz

Source forms:
  npm:<package>             Install from npm
  git:<repo-or-url>         Install from git
  ./path or /abs/path       Install from a local directory
  https://...               Install from a remote archive/repo URL

Notes:
  --local installs into the detected project root's .kordi directory.
  Without --local, installs go into ~/.kordi and are available globally.
"#)]
    /// Install a package source into settings (supports npm:pkg, git:repo/url, local path, or archive URL)
    Install {
        /// Install into project-local settings instead of global settings
        #[arg(short = 'l', long = "local")]
        local: bool,
        /// Package source, e.g. npm:kordi-example-skill, git:https://github.com/org/repo.git, ./my-skill, or https://example.com/package.tar.gz
        source: String,
    },
    /// Remove a package source from settings
    Remove {
        /// Remove from project-local settings instead of global settings
        #[arg(short = 'l', long = "local")]
        local: bool,
        /// Package source to remove
        source: String,
    },
    /// List configured package sources
    List {
        /// Only show project-local settings
        #[arg(short = 'l', long = "local")]
        local: bool,
        /// Only show global settings
        #[arg(long = "global")]
        global: bool,
    },
    /// Update installed package sources
    Update {
        /// Only update project-local settings
        #[arg(short = 'l', long = "local")]
        local: bool,
        /// Only update global settings
        #[arg(long = "global")]
        global: bool,
    },
}

fn system_prompt_template_dirs() -> Vec<std::path::PathBuf> {
    kordi_core::config::global_resource_dir_candidates("system-prompts")
}

fn resolve_system_prompt_template_path(template_name: &str) -> Option<std::path::PathBuf> {
    system_prompt_template_dirs()
        .into_iter()
        .map(|dir| dir.join(format!("{template_name}.md")))
        .find(|path| path.is_file())
}

fn list_system_prompt_templates() -> BTreeMap<String, std::path::PathBuf> {
    let mut found = BTreeMap::new();

    for templates_dir in system_prompt_template_dirs() {
        if !templates_dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&templates_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            found.entry(name.to_string()).or_insert(path);
        }
    }

    found
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(cwd) = cli.cwd.as_deref() {
        std::env::set_current_dir(cwd)?;
    }

    if let Ok(cwd) = std::env::current_dir() {
        let settings = kordi_core::settings::Settings::load_merged(&cwd);
        if settings.compatibility_mode {
            kordi_tui::theme::set_compatibility_mode(true);
        }
    }

    // In interactive mode, suppress tracing to avoid leaking into TUI.
    // In print mode or verbose, show warnings.
    let log_level = if cli.verbose {
        tracing::Level::DEBUG
    } else if cli.print {
        tracing::Level::WARN
    } else {
        tracing::Level::ERROR // interactive: only errors, no WARN noise in TUI
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive(log_level.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    // Handle subcommands
    if let Some(cmd) = &cli.command {
        let cwd = std::fs::canonicalize(cli.cwd.as_deref().unwrap_or("."))?;
        return match cmd {
            Commands::Login { provider } => login::handle_login(provider.as_deref()).await,
            Commands::Logout { provider } => login::handle_logout(provider.as_deref()).await,
            Commands::Install { local, source } => {
                let scope = if *local {
                    extensions::SettingsScope::Project
                } else {
                    extensions::SettingsScope::Global
                };
                extensions::install_package(source, scope, &cwd)?;
                println!("Installed package source: {source}");
                Ok(())
            }
            Commands::Remove { local, source } => {
                let scope = if *local {
                    extensions::SettingsScope::Project
                } else {
                    extensions::SettingsScope::Global
                };
                if extensions::remove_package(source, scope, &cwd)? {
                    println!("Removed package source: {source}");
                } else {
                    println!("Package source not found: {source}");
                }
                Ok(())
            }
            Commands::List { local, global } => {
                let scope = if *local {
                    Some(extensions::SettingsScope::Project)
                } else if *global {
                    Some(extensions::SettingsScope::Global)
                } else {
                    None
                };
                for source in extensions::list_packages(scope, &cwd) {
                    println!("{source}");
                }
                Ok(())
            }
            Commands::Update { local, global } => {
                let scope = if *local {
                    Some(extensions::SettingsScope::Project)
                } else if *global {
                    Some(extensions::SettingsScope::Global)
                } else {
                    None
                };
                let updated = extensions::update_packages(scope, &cwd)?;
                for source in updated {
                    println!("Updated {source}");
                }
                Ok(())
            }
        };
    }

    // Handle --list-templates
    if cli.list_templates {
        let templates = list_system_prompt_templates();
        if templates.is_empty() {
            println!("No templates directory. Create templates at:");
            println!(
                "  {}/",
                kordi_core::config::preferred_global_resource_dir("system-prompts").display()
            );
        } else {
            for (name, path) in templates {
                let desc = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|c| {
                        c.lines()
                            .find(|l| !l.trim().is_empty() && l.trim() != "---")
                            .map(|l| {
                                let s = l.trim().trim_start_matches("# ");
                                if s.len() > 60 {
                                    format!("{}...", &s[..57])
                                } else {
                                    s.to_string()
                                }
                            })
                    })
                    .unwrap_or_default();
                println!("  {name:20} {desc}");
            }
        }
        return Ok(());
    }

    // Handle --list-models
    if let Some(search) = &cli.list_models {
        let search_term = match search {
            Some(s) => Some(s.as_str()),
            None => {
                // Check if first message looks like a search term
                if !cli.messages.is_empty() && !cli.messages[0].contains(' ') {
                    Some(cli.messages[0].as_str())
                } else {
                    None
                }
            }
        };
        models::list_models(search_term).await;
        return Ok(());
    }

    // Resolve system prompt template or @file
    let mut cli = cli;
    if let Some(template_name) = &cli.system_prompt_template {
        let Some(template_path) = resolve_system_prompt_template_path(template_name) else {
            eprintln!(
                "Error: system prompt template '{}' not found under {}",
                template_name,
                kordi_core::config::preferred_global_resource_dir("system-prompts").display()
            );
            eprintln!("Available templates (kordi --list-templates):");
            for name in list_system_prompt_templates().keys() {
                eprintln!("  {name}");
            }
            std::process::exit(1);
        };
        cli.system_prompt = Some(std::fs::read_to_string(&template_path)?);
    } else if let Some(ref sp) = cli.system_prompt
        && let Some(path) = sp.strip_prefix('@')
    {
        match std::fs::read_to_string(path) {
            Ok(content) => cli.system_prompt = Some(content),
            Err(e) => {
                eprintln!("Error: could not read system prompt file '{}': {}", path, e);
                std::process::exit(1);
            }
        }
    }

    // Print mode stays thin; interactive terminal usage now defaults to the TUI.
    if cli.print {
        run::run_print_mode(cli).await
    } else {
        tui::run_tui_entry(session_bootstrap::SessionBootstrapOptions::from(&cli)).await
    }
}

// Cli is already visible to submodules via crate::Cli
