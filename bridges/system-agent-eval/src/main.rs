//! `system-agent-eval run` replays the fixtures against the configured
//! provider and writes a run report; `system-agent-eval compare` turns a
//! baseline report and candidate reports into a comparison.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use kordi_system_agent_eval::database::DisposableDatabase;
use kordi_system_agent_eval::{fixture, report, setup};

const USAGE: &str = "usage:
  system-agent-eval run --label NAME [--stub] [--fixtures DIR] [--only ID,ID] [--out FILE]
  system-agent-eval compare BASELINE.json CANDIDATE.json... [--markdown FILE] [--json FILE]
  system-agent-eval list [--fixtures DIR]

System agent fixtures need KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL: a PostgreSQL
server on this machine (Unix socket, localhost or a loopback address) and a
database to connect to for administration. Each run creates its own
kordi_eval_* database there, replays into it, and drops it afterwards; the
named database is never written to. The role needs CREATEDB.";

struct Args(Vec<String>);

impl Args {
    fn flag(&mut self, name: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|arg| arg != name);
        self.0.len() != before
    }

    fn value(&mut self, name: &str) -> Result<Option<String>> {
        let Some(index) = self.0.iter().position(|arg| arg == name) else {
            return Ok(None);
        };
        if index + 1 >= self.0.len() {
            bail!("{name} needs a value\n{USAGE}");
        }
        let value = self.0.remove(index + 1);
        self.0.remove(index);
        Ok(Some(value))
    }

    fn done(self) -> Result<Vec<String>> {
        if let Some(unknown) = self.0.iter().find(|arg| arg.starts_with("--")) {
            bail!("unknown option {unknown}\n{USAGE}");
        }
        Ok(self.0)
    }
}

fn load(args: &mut Args, now: chrono::DateTime<chrono::Utc>) -> Result<Vec<fixture::Fixture>> {
    let dir = args
        .value("--fixtures")?
        .map(PathBuf::from)
        .unwrap_or_else(kordi_system_agent_eval::default_fixture_dir);
    fixture::load_dir(&dir, now)
}

async fn run(mut args: Args) -> Result<()> {
    let label = args.value("--label")?.context("--label is required")?;
    if label.is_empty()
        || !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        bail!("--label may use letters, digits, '-', '_' and '.'");
    }
    let stub = args.flag("--stub");
    let only = args.value("--only")?;
    let out = args.value("--out")?;
    let now = chrono::Utc::now();
    let mut fixtures = load(&mut args, now)?;
    args.done()?;
    if let Some(only) = only {
        let wanted: Vec<&str> = only.split(',').map(str::trim).collect();
        fixtures.retain(|fixture| wanted.contains(&fixture.id()));
        if fixtures.len() != wanted.len() {
            bail!("--only names a fixture that does not exist");
        }
    }
    let settings = if stub {
        setup::stub_settings()
    } else {
        setup::live_settings()?
    };
    let needs_database = fixtures
        .iter()
        .any(|fixture| matches!(fixture, fixture::Fixture::SystemAgent(_)));
    let database = if needs_database {
        let url = std::env::var(setup::DATABASE_URL_VAR).with_context(|| {
            format!(
                "set {} to a PostgreSQL server on this machine",
                setup::DATABASE_URL_VAR
            )
        })?;
        Some(DisposableDatabase::prepare(&url).await?)
    } else {
        None
    };
    // Listen before anything is created, so an interrupt at any point still
    // reaches the cleanup below.
    let interrupted = interrupts()?;
    tokio::pin!(interrupted);
    let result = async {
        // The server's migration future is not `Send`, so the database is
        // created here rather than in the spawned task.
        let pool = match &database {
            Some(database) => {
                let pool = tokio::select! {
                    pool = database.create() => pool?,
                    () = &mut interrupted => bail!("interrupted"),
                };
                eprintln!("replaying into the new database {}", database.name());
                Some(pool)
            }
            None => None,
        };
        // The suite runs on its own task, so a panic also reaches the cleanup.
        let mut task = tokio::spawn(async move {
            let (config, harness) = match pool {
                Some(pool) => {
                    let harness = setup::harness(pool, settings.pending, settings.engine).await?;
                    (harness.config.clone(), Some(harness))
                }
                None => (settings.pending.unprovisioned(), None),
            };
            setup::run_suite(
                &label,
                &fixtures,
                &config,
                harness.as_ref(),
                settings.engine,
                settings.prices,
                now,
            )
            .await
        });
        tokio::select! {
            joined = &mut task => joined.unwrap_or_else(|error| Err(anyhow::anyhow!("the run stopped: {error}"))),
            () = &mut interrupted => {
                task.abort();
                let _ = (&mut task).await;
                Err(anyhow::anyhow!("interrupted"))
            }
        }
    }
    .await;
    if let Some(database) = database {
        let name = database.name().to_string();
        if database.drop_database().await {
            eprintln!("dropped the database {name}");
        }
    }
    let report = result?;
    let out = out.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from("target/system-agent-eval").join(format!("{}.json", report.label))
    });
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)? + "\n")?;
    let summary = &report.summary;
    eprintln!(
        "{}/{} fixtures passed; estimated cost {}; report written to {}",
        summary.fixtures.passed,
        summary.fixtures.total,
        report::cost(summary),
        out.display()
    );
    Ok(())
}

/// Resolves on Ctrl-C (or SIGTERM on Unix). The Unix handlers are installed
/// when this is called, not when the future is first polled.
#[cfg(unix)]
fn interrupts() -> Result<impl std::future::Future<Output = ()>> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
    })
}

#[cfg(not(unix))]
fn interrupts() -> Result<impl std::future::Future<Output = ()>> {
    Ok(async {
        let _ = tokio::signal::ctrl_c().await;
    })
}

fn compare(mut args: Args) -> Result<()> {
    let markdown = args.value("--markdown")?;
    let json = args.value("--json")?;
    let files = args.done()?;
    if files.len() < 2 {
        bail!("compare needs a baseline report and at least one candidate\n{USAGE}");
    }
    let read = |path: &String| -> Result<report::RunReport> {
        let raw = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
        let parsed: report::RunReport =
            serde_json::from_str(&raw).with_context(|| format!("parsing {path}"))?;
        if parsed.schema_version != report::SCHEMA_VERSION {
            bail!(
                "{path} has report schema {}, expected {}",
                parsed.schema_version,
                report::SCHEMA_VERSION
            );
        }
        Ok(parsed)
    };
    let baseline = read(&files[0])?;
    let candidates = files[1..].iter().map(read).collect::<Result<Vec<_>>>()?;
    for candidate in &candidates {
        let (added, removed) = report::fixture_set_diff(&baseline, candidate);
        if !added.is_empty() || !removed.is_empty() {
            eprintln!(
                "warning: {} and {} ran different fixtures (added: {}; removed: {})",
                baseline.label,
                candidate.label,
                if added.is_empty() {
                    "none".into()
                } else {
                    added.join(", ")
                },
                if removed.is_empty() {
                    "none".into()
                } else {
                    removed.join(", ")
                },
            );
        }
    }
    let (md, value) = report::compare(&baseline, &candidates);
    match markdown {
        Some(path) => std::fs::write(path, &md)?,
        None => print!("{md}"),
    }
    if let Some(path) = json {
        std::fs::write(path, serde_json::to_string_pretty(&value)? + "\n")?;
    }
    Ok(())
}

fn list(mut args: Args) -> Result<()> {
    let fixtures = load(&mut args, chrono::Utc::now())?;
    args.done()?;
    for fixture in fixtures {
        let description = match &fixture {
            fixture::Fixture::SystemAgent(conversation) => &conversation.description,
            fixture::Fixture::Grounding(build) => &build.description,
        };
        println!("{:<34} {:<12} {description}", fixture.id(), fixture.kind());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.is_empty() {
        bail!("{USAGE}");
    }
    let command = raw.remove(0);
    let args = Args(raw);
    match command.as_str() {
        "run" => run(args).await,
        "compare" => compare(args),
        "list" => list(args),
        _ => bail!("{USAGE}"),
    }
}
