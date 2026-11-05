use super::*;
use crate::score::Check;

fn pass(
    ran: bool,
    latency: u64,
    usage: Option<(u64, u64)>,
    checks: &[(&str, &str, bool)],
) -> PassResult {
    PassResult {
        ran,
        latency_ms: ran.then_some(latency),
        usage: usage.map(|(input, output)| UsageRecord {
            input_tokens: input,
            output_tokens: output,
            model_calls: 1,
            reported_calls: 1,
        }),
        checks: checks
            .iter()
            .map(|(metric, name, passed)| Check {
                metric: metric.to_string(),
                name: name.to_string(),
                passed: *passed,
                detail: (!passed).then(|| "detail".to_string()),
            })
            .collect(),
        outcome: Value::Null,
    }
}

fn report(label: &str, silent_ok: bool, card_ok: bool, prices: Option<Prices>) -> RunReport {
    let fixtures = vec![
        FixtureResult {
            id: "plan".into(),
            kind: "systemAgent".into(),
            passed: card_ok,
            passes: vec![pass(
                true,
                1200,
                Some((3000, 200)),
                &[
                    ("planCard", "state is confirmed", card_ok),
                    ("reliability", "run completes", true),
                ],
            )],
        },
        FixtureResult {
            id: "quiet".into(),
            kind: "systemAgent".into(),
            passed: silent_ok,
            passes: vec![
                pass(
                    true,
                    800,
                    Some((2000, 100)),
                    &[("silence", "stays silent", silent_ok)],
                ),
                pass(false, 0, None, &[("silence", "stays silent", true)]),
            ],
        },
    ];
    let summary = summarize(&fixtures, prices);
    RunReport {
        schema_version: SCHEMA_VERSION,
        label: label.into(),
        started_at: "2026-11-03T10:00:00+00:00".into(),
        provider: ProviderInfo {
            provider: "openai-compatible".into(),
            model: format!("{label}-model"),
            engine: "rust".into(),
            endpoint_host: "model.example.test".into(),
        },
        prices,
        fixtures,
        summary,
    }
}

#[test]
fn summary_counts_metrics_latency_tokens_and_cost() {
    let prices = Prices {
        input_per_million: 1.0,
        output_per_million: 4.0,
    };
    let summary = report("base", true, false, Some(prices)).summary;
    assert_eq!(
        summary.metrics["silence"],
        Tally {
            passed: 2,
            total: 2
        }
    );
    assert_eq!(
        summary.metrics["planCard"],
        Tally {
            passed: 0,
            total: 1
        }
    );
    assert_eq!(summary.metrics["repetition"], Tally::default());
    assert_eq!(
        summary.fixtures,
        Tally {
            passed: 1,
            total: 2
        }
    );
    assert_eq!((summary.model_runs, summary.skipped_by_sweep), (2, 1));
    assert_eq!(summary.latency_p50_ms, Some(1200));
    assert_eq!(summary.latency_max_ms, Some(1200));
    assert_eq!((summary.input_tokens, summary.output_tokens), (5000, 300));
    let cost = summary.cost_usd.unwrap();
    assert!((cost - 0.0062).abs() < 1e-9, "{cost}");
    assert!(report("base", true, true, None).summary.cost_usd.is_none());
}

#[test]
fn comparison_lists_regressions_and_improvements_per_candidate() {
    let baseline = report("baseline", true, false, None);
    let candidate = report("candidate", false, true, None);
    let (md, json) = compare(&baseline, &[candidate]);
    assert!(md.contains("| Silence when no hook applies | 2/2 (100%) | 1/2 (50%) -50 pts |"));
    assert!(md.contains("| Plan card correctness | 0/1 (0%) | 1/1 (100%) +100 pts |"));
    assert!(md.contains("| quiet | pass | **fail** (1) |"));
    assert!(md.contains("## Regressions in candidate\n\n- quiet / pass 1 / stays silent: detail"));
    assert!(md.contains("## Improvements in candidate\n\n- plan / pass 1 / state is confirmed"));
    assert_eq!(
        json["candidates"][0]["regressions"][0]["check"],
        "quiet / pass 1 / stays silent"
    );
    assert_eq!(json["baseline"]["label"], "baseline");
    // A report survives a JSON round trip, so saved runs can be compared later.
    let saved = serde_json::to_string(&baseline).unwrap();
    let loaded: RunReport = serde_json::from_str(&saved).unwrap();
    assert_eq!(loaded.summary.metrics, baseline.summary.metrics);
}

fn usage_pass(model_calls: u64, reported_calls: u64) -> PassResult {
    let mut pass = pass(true, 500, Some((1000, 100)), &[]);
    pass.usage = Some(UsageRecord {
        input_tokens: 1000 * reported_calls,
        output_tokens: 100 * reported_calls,
        model_calls,
        reported_calls,
    });
    pass
}

#[test]
fn cost_is_marked_partial_when_some_runs_report_no_usage() {
    let prices = Some(Prices {
        input_per_million: 1.0,
        output_per_million: 4.0,
    });
    let fixtures = vec![FixtureResult {
        id: "plan".into(),
        kind: "systemAgent".into(),
        passed: true,
        passes: vec![
            usage_pass(1, 1),
            usage_pass(2, 1),
            usage_pass(1, 0),
            // A run that failed before any model call has nothing to report.
            usage_pass(0, 0),
        ],
    }];
    let summary = summarize(&fixtures, prices);
    assert_eq!(summary.model_runs, 4);
    assert_eq!(summary.runs_with_usage, 2);
    assert_eq!(summary.runs_missing_usage, 2);
    assert!(summary.cost_partial);
    assert_eq!(
        cost(&summary),
        "≥ $0.0028 (partial: 2 of 4 runs reported usage)"
    );
    let saved: Summary = serde_json::from_value(serde_json::to_value(&summary).unwrap()).unwrap();
    assert!(saved.cost_partial);

    let complete = summarize(
        &[FixtureResult {
            passes: vec![usage_pass(1, 1), usage_pass(0, 0)],
            ..fixtures[0].clone()
        }],
        prices,
    );
    assert!(!complete.cost_partial);
    assert_eq!(cost(&complete), "$0.0014");

    let unreported = summarize(
        &[FixtureResult {
            passes: vec![usage_pass(1, 0)],
            ..fixtures[0].clone()
        }],
        prices,
    );
    assert_eq!(
        (unreported.cost_usd, unreported.cost_partial),
        (None, false)
    );
    assert_eq!(cost(&unreported), "not reported");
    assert_eq!(cost(&Summary::default()), "set prices to estimate");
}

#[test]
fn comparison_warns_when_fixture_sets_differ() {
    let baseline = report("baseline", true, true, None);
    let mut candidate = report("candidate", true, true, None);
    candidate.fixtures.retain(|fixture| fixture.id != "quiet");
    let mut extra = candidate.fixtures[0].clone();
    extra.id = "new-case".into();
    candidate.fixtures.push(extra);
    assert_eq!(
        fixture_set_diff(&baseline, &candidate),
        (vec!["new-case".to_string()], vec!["quiet".to_string()])
    );
    let (md, json) = compare(&baseline, &[candidate]);
    assert!(
        md.contains("> - candidate ran a different fixture set than baseline; added: new-case; removed: quiet"),
        "{md}"
    );
    assert!(md.contains("| quiet | pass | missing |"), "{md}");
    assert!(md.contains("| new-case | missing | pass |"), "{md}");
    assert_eq!(json["candidates"][0]["fixturesAdded"][0], "new-case");
    assert_eq!(json["candidates"][0]["fixturesRemoved"][0], "quiet");
    assert_eq!(json["warnings"].as_array().unwrap().len(), 1);

    let same = report("same", true, true, None);
    let (md, json) = compare(&baseline, &[same]);
    assert!(!md.contains("Warning"));
    assert!(json["warnings"].as_array().unwrap().is_empty());
}
