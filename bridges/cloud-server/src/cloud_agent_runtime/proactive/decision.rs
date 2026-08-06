use serde::Deserialize;

use super::SKILL_PACK_MANIFEST;

const BREAKDOWN_SKILLS: &[(&str, &str)] = &[
    ("unclear-goal", "clarification-first"),
    ("stalled-plan", "plan-completion"),
    ("unresolved-conflict", "conflict-mediation"),
    ("missed-constraint", "constraint-reminder"),
    ("lost-focus", "goal-refocusing"),
    ("repeated-loop", "loop-breaking"),
    ("participation-imbalance", "participation-balancing"),
    ("unmanaged-risk", "risk-check"),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ModelDecision {
    pub action: String,
    pub breakdown: String,
    pub selected_skill: String,
    #[serde(default)]
    pub evidence_message_ids: Vec<String>,
    #[serde(default)]
    pub response: Option<String>,
}

fn json_text(value: &str) -> &str {
    let trimmed = value.trim();
    let unwrapped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim();
    unwrapped.strip_suffix("```").unwrap_or(unwrapped).trim()
}

fn skill_is_known(skill: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(SKILL_PACK_MANIFEST)
        .ok()
        .and_then(|manifest| manifest.get("skills").cloned())
        .and_then(|skills| skills.as_array().cloned())
        .is_some_and(|skills| {
            skills
                .iter()
                .any(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(skill))
        })
}

fn intervention_skill_is_known(skill: &str) -> bool {
    !matches!(
        skill,
        "using-proactive-collaboration" | "breakdown-judgement"
    ) && skill_is_known(skill)
}

fn skill_for_breakdown(breakdown: &str) -> Option<&'static str> {
    BREAKDOWN_SKILLS
        .iter()
        .find_map(|(candidate, skill)| (*candidate == breakdown).then_some(*skill))
}

pub fn parse_model_decision(value: &str) -> Result<ModelDecision, &'static str> {
    let mut decision: ModelDecision =
        serde_json::from_str(json_text(value)).map_err(|_| "invalid_proactive_json")?;
    decision.action = decision.action.trim().to_ascii_lowercase();
    decision.breakdown = decision.breakdown.trim().to_string();
    decision.selected_skill = decision.selected_skill.trim().to_string();
    decision.evidence_message_ids = decision
        .evidence_message_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .take(12)
        .collect();
    if !skill_is_known(&decision.selected_skill) {
        return Err("unknown_proactive_skill");
    }
    if decision.action == "silence" {
        if decision.breakdown != "none"
            || decision.selected_skill != "breakdown-judgement"
            || !decision.evidence_message_ids.is_empty()
            || decision
                .response
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err("invalid_proactive_silence");
        }
        decision.response = None;
        return Ok(decision);
    }
    if decision.action != "intervene"
        || !intervention_skill_is_known(&decision.selected_skill)
        || skill_for_breakdown(&decision.breakdown) != Some(decision.selected_skill.as_str())
        || decision.evidence_message_ids.is_empty()
    {
        return Err("invalid_proactive_intervention");
    }
    let response = decision
        .response
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if response.is_empty() || response.split_whitespace().count() > 80 {
        return Err("invalid_proactive_response_length");
    }
    let sentence_count = response
        .split_inclusive(['.', '!', '?'])
        .filter(|sentence| !sentence.trim().is_empty())
        .count()
        .max(1);
    if sentence_count > 2 {
        return Err("invalid_proactive_response_length");
    }
    decision.response = Some(response.to_string());
    Ok(decision)
}

#[cfg(test)]
mod tests {
    use super::parse_model_decision;

    #[test]
    fn silence_has_no_visible_response() {
        let decision = parse_model_decision(
            r#"{"action":"silence","breakdown":"none","selectedSkill":"breakdown-judgement","evidenceMessageIds":[],"response":null}"#,
        )
        .expect("valid silence");
        assert_eq!(decision.action, "silence");
        assert!(decision.response.is_none());
        assert!(parse_model_decision(
            r#"{"action":"silence","breakdown":"none","selectedSkill":"breakdown-judgement","evidenceMessageIds":[],"response":"Do not show"}"#,
        )
        .is_err());
    }

    #[test]
    fn intervention_requires_evidence_and_matching_known_skill() {
        let decision = parse_model_decision(
            r#"{"action":"intervene","breakdown":"missed-constraint","selectedSkill":"constraint-reminder","evidenceMessageIds":["msg_1"],"response":"The launch window excludes Friday. Could we move this check to Thursday?"}"#,
        )
        .expect("valid intervention");
        assert_eq!(decision.selected_skill, "constraint-reminder");
        assert!(parse_model_decision(
            r#"{"action":"intervene","breakdown":"stalled-plan","selectedSkill":"risk-check","evidenceMessageIds":["msg_1"],"response":"Assign an owner before continuing."}"#,
        )
        .is_err());
    }
}
