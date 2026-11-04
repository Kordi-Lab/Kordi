//! Run reports (JSON, one per provider configuration) and the comparison of a
//! baseline run with candidate runs (Markdown and JSON).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::replay::UsageRecord;
use crate::score::{Check, METRICS};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub schema_version: u32,
    pub label: String,
    pub started_at: String,
    pub provider: ProviderInfo,
    #[serde(default)]
    pub prices: Option<Prices>,
    pub fixtures: Vec<FixtureResult>,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: String,
    pub model: String,
    pub engine: String,
    /// Host only; never a path, key, or query.
    pub endpoint_host: String,
}

/// US dollars per million tokens, from the environment.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prices {
    pub input_per_million: f64,
    pub output_per_million: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureResult {
    pub id: String,
    pub kind: String,
    pub passed: bool,
    pub passes: Vec<PassResult>,
}

/// One System agent pass or one card build.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassResult {
    /// Whether a model call happened (the sweep's free check may skip it).
    pub ran: bool,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub usage: Option<UsageRecord>,
    pub checks: Vec<Check>,
    /// What happened, for reading a failure.
    pub outcome: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub passed: usize,
    pub total: usize,
}

impl Tally {
    fn rate(&self) -> Option<f64> {
        (self.total > 0).then(|| self.passed as f64 / self.total as f64)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub metrics: BTreeMap<String, Tally>,
    pub fixtures: Tally,
    pub model_runs: usize,
    pub skipped_by_sweep: usize,
    pub latency_mean_ms: Option<u64>,
    pub latency_p50_ms: Option<u64>,
    pub latency_p95_ms: Option<u64>,
    pub latency_max_ms: Option<u64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Runs whose provider reported token counts.
    pub runs_with_usage: usize,
    pub cost_usd: Option<f64>,
}

fn percentile(sorted: &[u64], fraction: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    Some(sorted[index])
}

pub fn summarize(fixtures: &[FixtureResult], prices: Option<Prices>) -> Summary {
    let mut summary = Summary::default();
    for metric in METRICS {
        summary.metrics.insert(metric.to_string(), Tally::default());
    }
    let mut latencies = Vec::new();
    for fixture in fixtures {
        summary.fixtures.total += 1;
        summary.fixtures.passed += usize::from(fixture.passed);
        for pass in &fixture.passes {
            if pass.ran {
                summary.model_runs += 1;
                latencies.extend(pass.latency_ms);
            } else {
                summary.skipped_by_sweep += 1;
            }
            if let Some(usage) = pass.usage.filter(|usage| usage.reported_calls > 0) {
                summary.runs_with_usage += 1;
                summary.input_tokens += usage.input_tokens;
                summary.output_tokens += usage.output_tokens;
            }
            for check in &pass.checks {
                let tally = summary.metrics.entry(check.metric.clone()).or_default();
                tally.total += 1;
                tally.passed += usize::from(check.passed);
            }
        }
    }
    latencies.sort_unstable();
    if !latencies.is_empty() {
        summary.latency_mean_ms = Some(latencies.iter().sum::<u64>() / latencies.len() as u64);
    }
    summary.latency_p50_ms = percentile(&latencies, 0.5);
    summary.latency_p95_ms = percentile(&latencies, 0.95);
    summary.latency_max_ms = latencies.last().copied();
    summary.cost_usd = prices
        .filter(|_| summary.runs_with_usage > 0)
        .map(|prices| {
            (summary.input_tokens as f64 * prices.input_per_million
                + summary.output_tokens as f64 * prices.output_per_million)
                / 1_000_000.0
        });
    summary
}

fn metric_title(metric: &str) -> &str {
    match metric {
        "planCard" => "Plan card correctness",
        "silence" => "Silence when no hook applies",
        "reply" => "Replies when one is due",
        "toolValidity" => "Valid tool calls",
        "repetition" => "No repeated messages",
        "grounding" => "Grounding cards",
        "reliability" => "Runs completed",
        "sweep" => "Passes the sweep skipped correctly",
        other => other,
    }
}

fn tally_cell(tally: Option<&Tally>) -> String {
    match tally.and_then(|t| t.rate().map(|rate| (t, rate))) {
        Some((tally, rate)) => format!("{}/{} ({:.0}%)", tally.passed, tally.total, rate * 100.0),
        None => "n/a".into(),
    }
}

fn delta_points(base: Option<&Tally>, other: Option<&Tally>) -> String {
    match (base.and_then(Tally::rate), other.and_then(Tally::rate)) {
        (Some(base), Some(other)) => format!("{:+.0} pts", (other - base) * 100.0),
        _ => String::new(),
    }
}

fn ms(value: Option<u64>) -> String {
    value
        .map(|ms| format!("{ms} ms"))
        .unwrap_or_else(|| "n/a".into())
}

fn per_run(report: &RunReport) -> String {
    let summary = &report.summary;
    if summary.runs_with_usage == 0 {
        return "not reported".into();
    }
    let runs = summary.runs_with_usage as u64;
    format!(
        "{} in / {} out",
        summary.input_tokens / runs,
        summary.output_tokens / runs
    )
}

fn cost(report: &RunReport) -> String {
    match report.summary.cost_usd {
        Some(cost) => format!("${cost:.4}"),
        None => "set prices to estimate".into(),
    }
}

/// Every check of a run by a stable key: fixture, pass, check name and its
/// occurrence within the pass.
fn keyed_checks(report: &RunReport) -> BTreeMap<String, &Check> {
    let mut keyed = BTreeMap::new();
    for fixture in &report.fixtures {
        for (index, pass) in fixture.passes.iter().enumerate() {
            let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
            for check in &pass.checks {
                let count = seen.entry(&check.name).or_default();
                *count += 1;
                keyed.insert(
                    format!(
                        "{} / pass {} / {} #{}",
                        fixture.id,
                        index + 1,
                        check.name,
                        count
                    ),
                    check,
                );
            }
        }
    }
    keyed
}

/// Checks that pass in `from` and fail in `to`.
fn flipped(from: &RunReport, to: &RunReport) -> Vec<(String, Option<String>)> {
    let before = keyed_checks(from);
    keyed_checks(to)
        .into_iter()
        .filter(|(key, check)| !check.passed && before.get(key).is_some_and(|c| c.passed))
        .map(|(key, check)| {
            (
                key.trim_end_matches(" #1").to_string(),
                check.detail.clone(),
            )
        })
        .collect()
}

pub fn compare(baseline: &RunReport, candidates: &[RunReport]) -> (String, Value) {
    let runs: Vec<&RunReport> = std::iter::once(baseline).chain(candidates).collect();
    let mut md = String::from("# System agent quality comparison\n\n");
    for report in &runs {
        md.push_str(&format!(
            "- **{}**: {} `{}` via the {} engine ({}), {}\n",
            report.label,
            report.provider.provider,
            report.provider.model,
            report.provider.engine,
            report.provider.endpoint_host,
            report.started_at
        ));
    }
    let header: Vec<String> = runs.iter().map(|r| r.label.clone()).collect();
    md.push_str(&format!("\n| Metric | {} |", header.join(" | ")));
    md.push_str("\n|---|");
    md.push_str(&"---|".repeat(runs.len()));
    let mut row = |name: &str, cells: Vec<String>| {
        md.push_str(&format!("\n| {name} | {} |", cells.join(" | ")));
    };
    let base = &baseline.summary;
    for metric in METRICS {
        let base_tally = base.metrics.get(metric);
        let cells = runs
            .iter()
            .enumerate()
            .map(|(index, report)| {
                let tally = report.summary.metrics.get(metric);
                let delta = delta_points(base_tally, tally);
                if index == 0 || delta.is_empty() {
                    tally_cell(tally)
                } else {
                    format!("{} {delta}", tally_cell(tally))
                }
            })
            .collect();
        row(metric_title(metric), cells);
    }
    row(
        "Fixtures fully passing",
        runs.iter()
            .map(|r| tally_cell(Some(&r.summary.fixtures)))
            .collect(),
    );
    row(
        "Model runs (skipped by the sweep)",
        runs.iter()
            .map(|r| format!("{} ({})", r.summary.model_runs, r.summary.skipped_by_sweep))
            .collect(),
    );
    row(
        "Latency p50",
        runs.iter().map(|r| ms(r.summary.latency_p50_ms)).collect(),
    );
    row(
        "Latency p95",
        runs.iter().map(|r| ms(r.summary.latency_p95_ms)).collect(),
    );
    row("Tokens per run", runs.iter().map(|r| per_run(r)).collect());
    row("Estimated cost", runs.iter().map(|r| cost(r)).collect());

    md.push_str(&format!(
        "\n\n## Fixtures\n\n| Fixture | {} |\n|---|",
        header.join(" | ")
    ));
    md.push_str(&"---|".repeat(runs.len()));
    for fixture in &baseline.fixtures {
        let cells: Vec<String> = runs
            .iter()
            .map(
                |report| match report.fixtures.iter().find(|f| f.id == fixture.id) {
                    Some(found) if found.passed => "pass".into(),
                    Some(found) => {
                        let failed: usize = found
                            .passes
                            .iter()
                            .map(|p| p.checks.iter().filter(|c| !c.passed).count())
                            .sum();
                        format!("**fail** ({failed})")
                    }
                    None => "missing".into(),
                },
            )
            .collect();
        md.push_str(&format!("\n| {} | {} |", fixture.id, cells.join(" | ")));
    }

    let mut candidate_json = Vec::new();
    for candidate in candidates {
        let regressions = flipped(baseline, candidate);
        let improvements = flipped(candidate, baseline);
        for (title, list) in [
            ("Regressions", &regressions),
            ("Improvements", &improvements),
        ] {
            md.push_str(&format!("\n\n## {title} in {}\n", candidate.label));
            if list.is_empty() {
                md.push_str("\nNone.");
            }
            for (key, detail) in list {
                match detail {
                    Some(detail) => md.push_str(&format!("\n- {key}: {detail}")),
                    None => md.push_str(&format!("\n- {key}")),
                }
            }
        }
        let list = |items: &[(String, Option<String>)]| {
            items
                .iter()
                .map(|(key, detail)| json!({"check": key, "detail": detail}))
                .collect::<Vec<_>>()
        };
        candidate_json.push(json!({
            "label": candidate.label,
            "provider": candidate.provider,
            "summary": candidate.summary,
            "regressions": list(&regressions),
            "improvements": list(&improvements),
        }));
    }
    md.push('\n');
    let json = json!({
        "schemaVersion": SCHEMA_VERSION,
        "baseline": {"label": baseline.label, "provider": baseline.provider, "summary": baseline.summary},
        "candidates": candidate_json,
    });
    (md, json)
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
