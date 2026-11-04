//! `system-agent-eval run` replays the fixtures against the configured
//! provider and writes a run report; `system-agent-eval compare` turns a
//! baseline report and candidate reports into a comparison.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use kordi_system_agent_eval::{fixture, report, setup};

const USAGE: &str = "usage:
  system-agent-eval run --label NAME [--stub] [--fixtures DIR] [--only ID,ID] [--out FILE]
  system-agent-eval compare BASELINE.json CANDIDATE.json... [--markdown FILE] [--json FILE]
  system-agent-eval list [--fixtures DIR]";

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
    let (config, harness) = if needs_database {
        let url = std::env::var(setup::DATABASE_URL_VAR).with_context(|| {
            format!(
                "set {} to a disposable local database",
                setup::DATABASE_URL_VAR
            )
        })?;
        let pool = setup::connect(&url).await?;
        let harness = setup::harness(pool, settings.pending, settings.engine).await?;
        (harness.config.clone(), Some(harness))
    } else {
        (settings.pending.unprovisioned(), None)
    };
    let report = setup::run_suite(
        &label,
        &fixtures,
        &config,
        harness.as_ref(),
        settings.engine,
        settings.prices,
        now,
    )
    .await?;
    let out = out
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/system-agent-eval").join(format!("{label}.json")));
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report)? + "\n")?;
    let summary = &report.summary;
    eprintln!(
        "{}/{} fixtures passed; report written to {}",
        summary.fixtures.passed,
        summary.fixtures.total,
        out.display()
    );
    Ok(())
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
