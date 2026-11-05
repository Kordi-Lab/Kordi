use super::*;
use crate::client::ToolCall;
use crate::fixture::{Expect, ExpectCard, ExpectTopics};
use crate::grounding::{BuildOutcome, Topics};
use crate::replay::{CardSnapshot, TurnOutcome};
use serde_json::json;

fn expect(reply: &str) -> Expect {
    Expect {
        reply: reply.into(),
        message_includes: Vec::new(),
        allowed_actions: Vec::new(),
        required_actions: Vec::new(),
        card: None,
    }
}

fn card(revision: i64, state: &str, start_at: Option<&str>) -> CardSnapshot {
    CardSnapshot {
        event_id: "plan_a".into(),
        revision,
        state: state.into(),
        title: "Dinner at Luigi's".into(),
        start_at: start_at.map(str::to_string),
        location: Some("Luigi's".into()),
        option_count: 0,
        going: vec!["jordan".into()],
        declined: Vec::new(),
    }
}

fn call(action: &str, accepted: bool) -> ToolCall {
    ToolCall {
        action: action.into(),
        accepted,
        status: if accepted { 200 } else { 409 },
        error_code: (!accepted).then(|| "plan_card_revision_conflict".into()),
        arguments: json!({"action": action}),
    }
}

fn failed(checks: &[Check]) -> Vec<&str> {
    checks
        .iter()
        .filter(|check| !check.passed)
        .map(|check| check.metric.as_str())
        .collect()
}

#[test]
fn speaking_when_silence_is_expected_fails_only_silence() {
    let mut outcome = TurnOutcome {
        ran: true,
        ..TurnOutcome::default()
    };
    assert!(failed(&score_turn(&expect("silent"), &outcome, None)).is_empty());
    outcome.messages = vec!["Anyone up for dinner?".into()];
    assert_eq!(
        failed(&score_turn(&expect("silent"), &outcome, None)),
        vec!["silence"]
    );
    // A pass the sweep skipped has no run to complete, and its checks are
    // the sweep's, not the model's.
    let skipped = TurnOutcome::default();
    let checks = score_turn(&expect("silent"), &skipped, None);
    assert_eq!(checks.len(), 1);
    assert!(checks[0].passed);
    assert_eq!(checks[0].metric, "sweep");
}

#[test]
fn tool_calls_must_be_allowed_and_accepted() {
    let mut expectation = expect("any");
    expectation.allowed_actions = vec!["rsvp".into(), "confirm".into()];
    expectation.required_actions = vec!["confirm".into()];
    let outcome = TurnOutcome {
        ran: true,
        tool_calls: vec![
            call("rsvp", true),
            call("confirm", false),
            call("cancel", true),
        ],
        ..TurnOutcome::default()
    };
    let checks = score_turn(&expectation, &outcome, None);
    assert_eq!(
        failed(&checks),
        vec!["toolValidity", "toolValidity", "planCard"]
    );
    let rejected = checks.iter().find(|c| c.name.contains("confirm")).unwrap();
    assert!(rejected
        .detail
        .as_deref()
        .unwrap()
        .contains("plan_card_revision_conflict"));
}

#[test]
fn repeating_an_earlier_message_is_flagged() {
    assert!(near_duplicate(
        "Vote on the card so we can lock it in.",
        "vote on the card so we can lock it in!"
    ));
    assert!(near_duplicate(
        "Two days are on the table, so I opened a vote. Vote on the card so we can lock it in.",
        "Vote on the card so we can lock it in."
    ));
    assert!(!near_duplicate("Dinner is fixed.", "Picnic is canceled."));
    let outcome = TurnOutcome {
        ran: true,
        messages: vec!["Vote on the card so we can lock it in.".into()],
        earlier_messages: vec!["Vote on the card so we can lock it in!".into()],
        ..TurnOutcome::default()
    };
    assert_eq!(
        failed(&score_turn(&expect("any"), &outcome, None)),
        vec!["repetition"]
    );
}

#[test]
fn card_fields_compare_instants_and_identity() {
    let mut expectation = expect("any");
    expectation.card = Some(ExpectCard {
        status: None,
        state: vec!["awaiting_confirmation".into(), "confirmed".into()],
        title_includes: vec!["dinner".into()],
        start_at: Some(Some("2026-11-06T20:00:00+00:00".into())),
        location_includes: vec!["luigi".into()],
        option_count: None,
        same_card: true,
        going: vec!["jordan".into()],
        declined: vec!["riya".into()],
    });
    let outcome = TurnOutcome {
        ran: true,
        // The same instant written in another offset.
        card: Some(card(4, "confirmed", Some("2026-11-07T05:00:00+09:00"))),
        ..TurnOutcome::default()
    };
    let checks = score_turn(&expectation, &outcome, Some("plan_a"));
    let names: Vec<&str> = checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, vec!["riya is declined"]);
    let other_card = score_turn(&expectation, &outcome, Some("plan_b"));
    assert!(other_card
        .iter()
        .any(|c| c.name == "updates the existing card" && !c.passed));
}

#[test]
fn card_status_none_unchanged_and_unset_time() {
    let mut expectation = expect("any");
    let status = |status: &str| ExpectCard {
        status: Some(status.into()),
        state: Vec::new(),
        title_includes: Vec::new(),
        start_at: None,
        location_includes: Vec::new(),
        option_count: None,
        same_card: false,
        going: Vec::new(),
        declined: Vec::new(),
    };
    expectation.card = Some(status("unchanged"));
    let mut outcome = TurnOutcome {
        ran: true,
        card_before: Some(card(3, "confirmed", None)),
        card: Some(card(3, "confirmed", None)),
        ..TurnOutcome::default()
    };
    assert!(failed(&score_turn(&expectation, &outcome, None)).is_empty());
    outcome.card = Some(card(4, "awaiting_confirmation", None));
    assert_eq!(
        failed(&score_turn(&expectation, &outcome, None)),
        vec!["planCard"]
    );
    expectation.card = Some(status("none"));
    assert_eq!(
        failed(&score_turn(&expectation, &outcome, None)),
        vec!["planCard"]
    );
    let mut unset = status("");
    unset.status = None;
    unset.start_at = Some(None);
    expectation.card = Some(unset);
    assert!(failed(&score_turn(&expectation, &outcome, None)).is_empty());
}

#[test]
fn a_failed_run_counts_against_reliability() {
    let outcome = TurnOutcome {
        ran: true,
        error: Some("provider error: rate limited".into()),
        ..TurnOutcome::default()
    };
    assert_eq!(
        failed(&score_turn(&expect("message"), &outcome, None)),
        vec!["reliability", "reply"]
    );
}

#[test]
fn card_builds_check_topics_citations_and_exclusions() {
    let expectation = ExpectTopics {
        min_current_topics: 2,
        must_mention: vec![vec!["dashboard".into()], vec!["climb".into()]],
        must_not_mention: vec!["crypto".into()],
    };
    let outcome = BuildOutcome {
        topics: Some(Topics {
            working_on: vec!["Usage dashboard".into()],
            interests: vec!["Crypto investing".into()],
            uncited: vec!["Crypto investing".into()],
            ..Topics::default()
        }),
        ..BuildOutcome::default()
    };
    let checks = score_build(&expectation, &outcome);
    let failures: Vec<&str> = checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(
        failures,
        vec![
            "every topic cites evidence",
            "mentions climb",
            "leaves out crypto"
        ]
    );
    let rejected = BuildOutcome {
        rejected: Some("invalid_output".into()),
        ..BuildOutcome::default()
    };
    assert_eq!(
        failed(&score_build(&expectation, &rejected)),
        vec!["grounding"]
    );
}
