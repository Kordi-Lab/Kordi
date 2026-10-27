use serde_json::json;

use super::*;

fn material() -> Material {
    Material {
        profile_name: "Fudan alumni".into(),
        focus: Some("Founding a startup in Shanghai".into()),
        topics: Topics {
            working_on: vec!["Agent memory".into()],
            interests: vec!["Coffee".into(), "Rock climbing".into()],
            can_help: vec!["Fundraising".into()],
            looking_for: vec!["Cofounder".into()],
            ..Topics::default()
        },
        open_to: vec!["Coffee chat".into()],
    }
}

fn people() -> Vec<(String, Material)> {
    vec![
        ("p1".to_string(), material()),
        ("p2".to_string(), Material::default()),
    ]
}

fn reply(checks: Value) -> String {
    json!({
        "conditions": ["Is a Fudan alum", "Wants a coffee chat"],
        "people": [{ "ref": "p1", "checks": checks }],
    })
    .to_string()
}

#[test]
fn proven_checks_meet_the_request() {
    let text = reply(json!([
        {"condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "fudan"},
        {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "coffee  CHAT"},
    ]));
    let checked = parse_checks(&text, &people()).unwrap();
    assert_eq!(checked.len(), 2);
    assert!(checked[0].met(), "{checked:?}");
    assert_eq!(
        checked[0].checks[1].evidence.as_deref(),
        Some("Coffee chat")
    );
    // The candidate the reply left out gets unknown for every condition.
    assert!(!checked[1].met());
    assert!(checked[1]
        .checks
        .iter()
        .all(|c| c.verdict == Verdict::Unknown));
}

#[test]
fn a_topic_alone_never_proves_willingness_or_affiliation() {
    let text = reply(json!([
        // "Coffee" is an interest, not something they are open to.
        {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee"},
        // "Rock climbing" is an interest, not an affiliation with a school.
        {"condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "Fudan University"},
    ]));
    let checked = &parse_checks(&text, &people()).unwrap()[0];
    assert!(!checked.met());
    assert_eq!(
        checked.checks[0].verdict,
        Verdict::Unknown,
        "not in the profile as words"
    );
    assert_eq!(checked.checks[1].verdict, Verdict::Unknown);
    assert_eq!(
        checked.checks[1].evidence, None,
        "unproven evidence is dropped"
    );
}

#[test]
fn each_kind_needs_its_own_source() {
    let m = material();
    let ok = |kind, evidence: &str| proof(kind, evidence, &m).is_some();
    assert!(ok(Kind::Interest, "rock climbing"));
    assert!(
        ok(Kind::Interest, "Agent memory"),
        "any shared topic is an interest"
    );
    assert!(ok(Kind::Work, "agent memory"));
    assert!(!ok(Kind::Work, "Coffee"), "an interest is not work");
    assert!(ok(Kind::Affiliation, "Fudan"));
    assert!(ok(Kind::Affiliation, "a startup"));
    assert!(!ok(Kind::Affiliation, "Fud"), "whole words only");
    assert!(!ok(Kind::Affiliation, "MIT"));
    assert!(ok(Kind::Willingness, "Coffee chat"));
    assert!(!ok(Kind::Willingness, "Fundraising"));
    assert!(!ok(Kind::Interest, "Sailing"), "a fabricated label");
    assert!(!ok(Kind::Affiliation, ""));
}

#[test]
fn a_school_interest_is_not_evidence_of_affiliation() {
    let mut interested = material();
    interested.profile_name = "Personal".into();
    interested.focus = None;
    interested.topics.interests.push("Fudan".into());
    let text = reply(json!([
        {"condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "Fudan"},
        {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee chat"},
    ]));
    let checked = parse_checks(&text, &[("p1".into(), interested.clone())]).unwrap();
    assert!(
        !checked[0].met(),
        "an interest in a school does not establish affiliation"
    );
    assert_eq!(checked[0].checks[0].verdict, Verdict::Unknown);
    assert_eq!(checked[0].checks[0].evidence, None);

    let previously_proven = parse_checks(&text, &people()).unwrap();
    assert!(previously_proven[0].met());
    assert!(!previously_proven[0].revalidated(&interested).met());
}

#[test]
fn fabricated_or_malformed_checks_are_downgraded() {
    let text = reply(json!([
        {"condition": 0, "verdict": "met", "kind": "interest", "evidence": "Quantum chess"},
        {"condition": 1, "verdict": "met", "kind": "vibes", "evidence": "Coffee chat"},
        {"condition": 7, "verdict": "met", "kind": "interest", "evidence": "Coffee"},
    ]));
    let checked = &parse_checks(&text, &people()).unwrap()[0];
    assert_eq!(checked.checks.len(), 2);
    assert!(checked.checks.iter().all(|c| c.verdict == Verdict::Unknown));
    assert_eq!(checked.checks[1].kind, None);
    let missing = reply(json!([{"condition": 0, "verdict": "met", "kind": "work"}]));
    assert_eq!(
        parse_checks(&missing, &people()).unwrap()[0].checks[0].verdict,
        Verdict::Unknown,
        "a met without evidence"
    );
    let not_met =
        reply(json!([{"condition": 0, "verdict": "not_met", "kind": "work", "evidence": "x"}]));
    let check = &parse_checks(&not_met, &people()).unwrap()[0].checks[0];
    assert_eq!(
        (check.verdict, check.evidence.clone()),
        (Verdict::NotMet, None)
    );
}

#[test]
fn the_parser_accepts_fenced_json_and_refuses_non_checks() {
    let fenced = format!(
        "Here you go:\n```json\n{}\n```",
        reply(
            json!([{"condition": 0, "verdict": "met", "kind": "work", "evidence": "Agent memory"}])
        )
    );
    let checked = parse_checks(&fenced, &people()).unwrap();
    assert_eq!(checked[0].checks[0].verdict, Verdict::Met);
    assert!(parse_checks("no json", &people()).is_none());
    assert!(
        parse_checks("{\"people\": []}", &people()).is_none(),
        "conditions are required"
    );
    assert!(parse_checks("{\"conditions\": [], \"people\": []}", &people()).is_none());
    let five =
        json!({"conditions": ["a", "b", "c", "d", "e"], "people": [{"ref": "p1", "checks": []}]});
    assert!(
        parse_checks(&five.to_string(), &people()).is_none(),
        "at most 4 conditions"
    );
    let nobody = json!({"conditions": ["a"], "people": [{"ref": "p9", "checks": []}]});
    assert!(parse_checks(&nobody.to_string(), &people()).is_none());
    let odd = json!({"conditions": ["a", 3], "people": [{"ref": "p1", "checks": []}]});
    assert!(parse_checks(&odd.to_string(), &people()).is_none());
}

#[test]
fn revalidation_follows_current_material() {
    let text = reply(json!([
        {"condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "Fudan"},
        {"condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee chat"},
    ]));
    let checked = parse_checks(&text, &people()).unwrap().remove(0);
    assert!(checked.revalidated(&material()).met());
    let mut changed = material();
    changed.open_to.clear();
    let again = checked.revalidated(&changed);
    assert!(!again.met());
    assert_eq!(again.checks[1].verdict, Verdict::Unknown);
}

#[test]
fn the_prompt_holds_only_shared_material() {
    let prompt = check_prompt("Coffee with a Fudan alum", &people());
    assert!(prompt.starts_with("Request: Coffee with a Fudan alum"));
    assert!(prompt.contains("[p1]\n  Profile: Fudan alumni (Founding a startup in Shanghai)"));
    assert!(prompt.contains("  Open to: Coffee chat\n"));
    assert!(prompt.contains("[p2]"));
    assert!(!prompt.contains("acct_"));
}
