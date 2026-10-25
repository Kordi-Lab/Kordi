//! The evaluation's answer. Anything that is not the documented object, or
//! an `offer` without a problem and a plan, is silence: unlike PiP, bare text
//! is never treated as something to post.

use serde::Deserialize;

const PROBLEM_LIMIT: usize = 300;
const OFFER_LIMIT: usize = 600;
const PLAN_LIMIT: usize = 600;
const EVIDENCE_LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Offer {
    pub problem: String,
    pub offer: String,
    pub plan: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Decision {
    Silence,
    Offer(Offer),
}

#[derive(Deserialize)]
struct Raw {
    decision: String,
    #[serde(default)]
    problem: Option<String>,
    #[serde(default)]
    offer: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    evidence: Vec<serde_json::Value>,
}

fn clean(value: Option<String>, limit: usize) -> Option<String> {
    let text = value?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > limit {
        text.chars().take(limit).collect::<String>() + "\u{2026}"
    } else {
        text
    })
}

pub(super) fn parse(text: &str) -> Decision {
    let trimmed = text.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|rest| rest.trim_end().trim_end_matches("```").trim())
        .unwrap_or(trimmed);
    let Ok(raw) = serde_json::from_str::<Raw>(trimmed) else {
        return Decision::Silence;
    };
    if raw.decision.trim() != "offer" {
        return Decision::Silence;
    }
    let (Some(problem), Some(offer), Some(plan)) = (
        clean(raw.problem, PROBLEM_LIMIT),
        clean(raw.offer, OFFER_LIMIT),
        clean(raw.plan, PLAN_LIMIT),
    ) else {
        return Decision::Silence;
    };
    let mut evidence: Vec<String> = Vec::new();
    for id in raw.evidence.iter().filter_map(serde_json::Value::as_str) {
        let id = id.trim();
        if !id.is_empty() && !evidence.iter().any(|seen| seen == id) {
            evidence.push(id.to_string());
        }
    }
    evidence.truncate(EVIDENCE_LIMIT);
    Decision::Offer(Offer {
        problem,
        offer,
        plan,
        evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_offer_is_parsed() {
        let decision = parse(
            "```json\n{\"decision\":\"offer\",\"problem\":\"Build fails on CI\",\"offer\":\"Riya, I can look at the failing step.\",\"plan\":\"Read the log\\nPropose a fix\",\"evidence\":[\"m1\",\"m1\",\"m2\",3]}\n```",
        );
        assert_eq!(
            decision,
            Decision::Offer(Offer {
                problem: "Build fails on CI".into(),
                offer: "Riya, I can look at the failing step.".into(),
                plan: "Read the log\nPropose a fix".into(),
                evidence: vec!["m1".into(), "m2".into()],
            })
        );
    }

    #[test]
    fn everything_else_is_silence() {
        assert_eq!(parse("{\"decision\":\"silence\"}"), Decision::Silence);
        assert_eq!(parse("Sure, I can help with that!"), Decision::Silence);
        assert_eq!(parse(""), Decision::Silence);
        assert_eq!(parse("[]"), Decision::Silence);
        assert_eq!(
            parse("{\"decision\":\"offer\",\"problem\":\"x\",\"offer\":\"y\"}"),
            Decision::Silence,
            "an offer without a plan"
        );
        assert_eq!(
            parse("{\"decision\":\"offer\",\"offer\":\"y\",\"plan\":\"z\"}"),
            Decision::Silence,
            "an offer without a problem"
        );
        assert_eq!(
            parse("{\"decision\":\"offer\",\"problem\":\" \",\"offer\":\"y\",\"plan\":\"z\"}"),
            Decision::Silence
        );
        assert_eq!(
            parse("{\"decision\":\"maybe\",\"problem\":\"x\",\"offer\":\"y\",\"plan\":\"z\"}"),
            Decision::Silence
        );
    }

    #[test]
    fn long_fields_are_bounded() {
        let long = "x".repeat(2_000);
        let text = serde_json::json!({"decision":"offer","problem":long,"offer":long,"plan":long})
            .to_string();
        let Decision::Offer(offer) = parse(&text) else {
            panic!("offer expected");
        };
        assert_eq!(offer.problem.chars().count(), PROBLEM_LIMIT + 1);
        assert_eq!(offer.offer.chars().count(), OFFER_LIMIT + 1);
    }
}
