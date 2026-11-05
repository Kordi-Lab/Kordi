//! Scores one pass or card build against its fixture's expectations. Every
//! check belongs to one metric so runs can be compared metric by metric.

use std::collections::BTreeSet;

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use crate::fixture::{Expect, ExpectCard, ExpectTopics};
use crate::grounding::BuildOutcome;
use crate::replay::{CardSnapshot, TurnOutcome};

/// Metric names, in report order.
pub const METRICS: [&str; 8] = [
    "planCard",
    "silence",
    "reply",
    "toolValidity",
    "repetition",
    "grounding",
    "reliability",
    "sweep",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub metric: String,
    pub name: String,
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn check(metric: &str, name: impl Into<String>, passed: bool, detail: Option<String>) -> Check {
    Check {
        metric: metric.to_string(),
        name: name.into(),
        passed,
        detail: if passed { None } else { detail },
    }
}

fn includes_any(text: &str, words: &[String]) -> bool {
    let text = text.to_lowercase();
    words.iter().any(|word| text.contains(&word.to_lowercase()))
}

fn words(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether two messages say the same thing: the same words, give or take a
/// few, or one contained in the other.
pub fn near_duplicate(a: &str, b: &str) -> bool {
    let (a, b) = (words(a), words(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let shared = a.intersection(&b).count() as f64;
    let union = a.union(&b).count() as f64;
    shared / union >= 0.8 || (shared as usize == a.len().min(b.len()) && shared >= 5.0)
}

pub fn score_turn(
    expect: &Expect,
    outcome: &TurnOutcome,
    seeded_event: Option<&str>,
) -> Vec<Check> {
    let mut checks = model_checks(expect, outcome, seeded_event);
    // Without a model call the result is the same for every provider, so it
    // is kept out of the model metrics.
    if !outcome.ran {
        for check in &mut checks {
            check.metric = "sweep".to_string();
        }
    }
    checks
}

fn model_checks(expect: &Expect, outcome: &TurnOutcome, seeded_event: Option<&str>) -> Vec<Check> {
    let mut checks = Vec::new();
    if outcome.ran {
        checks.push(check(
            "reliability",
            "run completes",
            outcome.error.is_none(),
            outcome.error.clone(),
        ));
    }
    let posted = outcome.messages.join(" | ");
    match expect.reply.as_str() {
        "silent" => checks.push(check(
            "silence",
            "stays silent",
            outcome.messages.is_empty(),
            Some(format!("posted: {posted}")),
        )),
        "message" => {
            checks.push(check(
                "reply",
                "posts a message",
                !outcome.messages.is_empty(),
                Some("no message".into()),
            ));
            for group in &expect.message_includes {
                checks.push(check(
                    "reply",
                    format!("message mentions {}", group.join(" or ")),
                    includes_any(&posted, group),
                    Some(format!("posted: {posted}")),
                ));
            }
        }
        _ => {}
    }
    for call in &outcome.tool_calls {
        let allowed = expect.allowed_actions.contains(&call.action);
        let detail = if !allowed {
            format!("{} is not expected here", call.action)
        } else {
            format!(
                "rejected with {} {}",
                call.status,
                call.error_code.as_deref().unwrap_or("")
            )
        };
        checks.push(check(
            "toolValidity",
            format!("plan_card {} is expected and accepted", call.action),
            allowed && call.accepted,
            Some(detail),
        ));
    }
    for action in &expect.required_actions {
        let used = outcome
            .tool_calls
            .iter()
            .any(|call| call.accepted && &call.action == action);
        checks.push(check(
            "planCard",
            format!("uses plan_card {action}"),
            used,
            Some("not called successfully".into()),
        ));
    }
    let mut seen = outcome.earlier_messages.clone();
    for message in &outcome.messages {
        let repeated = seen.iter().find(|earlier| near_duplicate(earlier, message));
        checks.push(check(
            "repetition",
            "does not repeat an earlier message",
            repeated.is_none(),
            repeated.map(|earlier| format!("{message:?} repeats {earlier:?}")),
        ));
        seen.push(message.clone());
    }
    if let Some(card) = &expect.card {
        checks.extend(score_card(card, outcome, seeded_event));
    }
    checks
}

fn same_instant(actual: Option<&str>, expected: &str) -> bool {
    let parse = |value: &str| DateTime::parse_from_rfc3339(value).ok();
    match (actual.and_then(parse), parse(expected)) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => false,
    }
}

fn score_card(
    expect: &ExpectCard,
    outcome: &TurnOutcome,
    seeded_event: Option<&str>,
) -> Vec<Check> {
    let card = outcome.card.as_ref();
    match expect.status.as_deref() {
        Some("none") => {
            return vec![check(
                "planCard",
                "creates no card",
                card.is_none(),
                card.map(|card| format!("created {:?}", card.title)),
            )]
        }
        Some("unchanged") => {
            let unchanged =
                card.map(|c| c.revision) == outcome.card_before.as_ref().map(|c| c.revision);
            return vec![check(
                "planCard",
                "leaves the card unchanged",
                unchanged,
                card.map(|card| format!("now revision {} ({})", card.revision, card.state)),
            )];
        }
        _ => {}
    }
    let Some(card) = card else {
        return vec![check(
            "planCard",
            "a card exists",
            false,
            Some("no card".into()),
        )];
    };
    let mut checks = Vec::new();
    let describe = |card: &CardSnapshot| {
        format!(
            "{} {:?} at {:?} in {:?}",
            card.state, card.title, card.start_at, card.location
        )
    };
    if !expect.state.is_empty() {
        checks.push(check(
            "planCard",
            format!("state is {}", expect.state.join(" or ")),
            expect.state.contains(&card.state),
            Some(describe(card)),
        ));
    }
    if !expect.title_includes.is_empty() {
        checks.push(check(
            "planCard",
            format!("title mentions {}", expect.title_includes.join(" or ")),
            includes_any(&card.title, &expect.title_includes),
            Some(describe(card)),
        ));
    }
    match &expect.start_at {
        Some(Some(expected)) => checks.push(check(
            "planCard",
            format!("starts at {expected}"),
            same_instant(card.start_at.as_deref(), expected),
            Some(describe(card)),
        )),
        Some(None) => checks.push(check(
            "planCard",
            "leaves the time unset",
            card.start_at.is_none(),
            Some(describe(card)),
        )),
        None => {}
    }
    if !expect.location_includes.is_empty() {
        checks.push(check(
            "planCard",
            format!(
                "location mentions {}",
                expect.location_includes.join(" or ")
            ),
            card.location
                .as_deref()
                .is_some_and(|location| includes_any(location, &expect.location_includes)),
            Some(describe(card)),
        ));
    }
    if let Some(count) = expect.option_count {
        checks.push(check(
            "planCard",
            format!("offers {count} options"),
            card.option_count == count,
            Some(format!("{} options", card.option_count)),
        ));
    }
    if expect.same_card {
        checks.push(check(
            "planCard",
            "updates the existing card",
            seeded_event == Some(card.event_id.as_str()),
            Some("a different card".into()),
        ));
    }
    for (list, expected, label) in [
        (&card.going, &expect.going, "going"),
        (&card.declined, &expect.declined, "declined"),
    ] {
        for key in expected {
            checks.push(check(
                "planCard",
                format!("{key} is {label}"),
                list.contains(key),
                Some(format!("{label}: {}", list.join(", "))),
            ));
        }
    }
    checks
}

pub fn score_build(expect: &ExpectTopics, outcome: &BuildOutcome) -> Vec<Check> {
    let mut checks = vec![check(
        "reliability",
        "run completes",
        outcome.error.is_none(),
        outcome.error.clone(),
    )];
    if outcome.error.is_some() {
        return checks;
    }
    checks.push(check(
        "grounding",
        "reply becomes a card",
        outcome.topics.is_some(),
        outcome.rejected.clone(),
    ));
    let Some(topics) = &outcome.topics else {
        return checks;
    };
    let current: Vec<&String> = topics.current().collect();
    checks.push(check(
        "grounding",
        format!("at least {} current topics", expect.min_current_topics),
        current.len() >= expect.min_current_topics,
        Some(format!("{} topics", current.len())),
    ));
    checks.push(check(
        "grounding",
        "every topic cites evidence",
        topics.uncited.is_empty(),
        Some(format!("uncited: {}", topics.uncited.join(", "))),
    ));
    let labels: Vec<&String> = current.iter().copied().chain(&topics.earlier).collect();
    let joined = labels
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join(" | ");
    for group in &expect.must_mention {
        checks.push(check(
            "grounding",
            format!("mentions {}", group.join(" or ")),
            current.iter().any(|label| includes_any(label, group)),
            Some(format!("topics: {joined}")),
        ));
    }
    for word in &expect.must_not_mention {
        checks.push(check(
            "grounding",
            format!("leaves out {word}"),
            !labels
                .iter()
                .any(|label| includes_any(label, std::slice::from_ref(word))),
            Some(format!("topics: {joined}")),
        ));
    }
    checks
}

#[cfg(test)]
#[path = "score_tests.rs"]
mod tests;
