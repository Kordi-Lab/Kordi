use chrono::NaiveDate;
use serde_json::json;

use super::super::card::{Evidence, Topics};
use super::super::prompt::{parse_reply, user_prompt, Gathered};
use super::super::{build, pairing, profile, redact, rooms};

fn day(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn gathered(source: &str, title: &str, date: Option<&str>) -> Gathered {
    Gathered {
        source: source.into(),
        title: title.into(),
        date: date.map(str::to_string),
        url: None,
        text: format!("{title} details"),
    }
}

fn evidence(id: &str, date: Option<&str>) -> Evidence {
    Evidence {
        id: id.into(),
        source: "Memory".into(),
        title: id.into(),
        date: date.map(str::to_string),
        url: None,
        snippet: String::new(),
    }
}

#[test]
fn activation_favors_recent_and_repeated_evidence() {
    let today = day("2026-10-18");
    let recent = profile::activation(&[Some("2026-10-01")], today).unwrap();
    let old = profile::activation(&[Some("2024-10-01")], today).unwrap();
    let repeated = profile::activation(&[Some("2026-10-01"), Some("2026-09-01")], today).unwrap();
    assert!(recent > old);
    assert!(repeated > recent);
    // Undated items count as current.
    assert_eq!(profile::activation(&[None], today), Some(0.0));
    assert_eq!(profile::activation(&[], today), None);
}

#[test]
fn periods_use_quarters_for_the_last_year_then_years() {
    let today = day("2026-10-18");
    assert_eq!(profile::period(day("2026-08-02"), today).1, "2026 Q3");
    assert_eq!(profile::period(day("2025-11-02"), today).1, "2025 Q4");
    assert_eq!(profile::period(day("2024-03-02"), today).1, "2024");
}

#[test]
fn profile_ranks_latest_and_places_each_topic_once_on_the_timeline() {
    let mut topics = Topics {
        working_on: vec!["Agent memory".into(), "Old project".into()],
        interests: vec!["Retrieval".into()],
        can_help: vec!["Hidden skill".into()],
        earlier: vec!["Speech".into()],
        ..Topics::default()
    };
    for (label, ids) in [
        ("Agent memory", vec!["e1", "e2"]),
        ("Old project", vec!["e3"]),
        ("Retrieval", vec!["e4"]),
        ("Hidden skill", vec!["e1"]),
        ("Speech", vec!["e3"]),
    ] {
        topics
            .refs
            .insert(label.into(), ids.into_iter().map(str::to_string).collect());
    }
    let evidence = vec![
        evidence("e1", Some("2026-10-01")),
        evidence("e2", Some("2026-09-01")),
        evidence("e3", Some("2024-02-01")),
        evidence("e4", None),
        evidence("unused", Some("2026-10-01")),
    ];
    let view = profile::build(
        &topics,
        &evidence,
        &["Hidden skill".into()],
        day("2026-10-18"),
    );
    // Hidden topics and topics without recent evidence are left out.
    assert_eq!(view["latest"], json!(["Agent memory", "Retrieval"]));
    assert_eq!(view["earlier"], json!(["Speech"]));
    assert_eq!(
        view["timeline"],
        json!([
            {"period": "2026 Q4", "topics": ["Hidden skill"]},
            {"period": "2026 Q3", "topics": ["Agent memory"]},
            {"period": "2024", "topics": ["Old project", "Speech"]},
        ])
    );
    assert_eq!(view["topics"]["Agent memory"]["refs"], json!(["e1", "e2"]));
    assert_eq!(view["topics"]["Agent memory"]["firstSeen"], "2026-09-01");
    assert!(
        view["evidence"].get("unused").is_none(),
        "only cited evidence is shown"
    );
}

#[test]
fn reply_parsing_keeps_cited_evidence_and_drops_the_rest() {
    let gathered = vec![
        gathered("Memory", "Agent memory study", Some("2026-10-01")),
        gathered("Notes", "Your notes", Some("2026-10-18")),
        gathered("Memory", "Dentist", Some("2026-10-02")),
    ];
    let reply = r#"Here is the card:
```json
{"working_on":[{"label":"  Agent   memory ","evidence":[0,0,1,9,-1]},{"label":"agent memory","evidence":[1]}],
 "interests":[{"label":"Retrieval","evidence":[]}],
 "can_help":[],"looking_for":[{"label":"Eval datasets","evidence":[1]}],
 "earlier":[{"label":"A","evidence":[]},{"label":"B","evidence":[]},{"label":"C","evidence":[]},{"label":"D","evidence":[]},{"label":"E","evidence":[]}]}
```"#;
    let (topics, evidence) = parse_reply(reply, &gathered).unwrap();
    assert_eq!(
        topics.working_on,
        vec!["Agent memory"],
        "duplicates are dropped ignoring case"
    );
    assert_eq!(topics.interests, vec!["Retrieval"]);
    assert_eq!(topics.looking_for, vec!["Eval datasets"]);
    assert_eq!(topics.earlier.len(), 4);
    assert_eq!(topics.refs["Agent memory"], vec!["e1", "e2"]);
    let ids: Vec<&str> = evidence.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["e1", "e2"], "uncited evidence is not kept");
    assert_eq!(evidence[0].snippet, "Agent memory study details");
}

#[test]
fn a_reply_without_topics_is_not_a_card() {
    let gathered = vec![gathered("Notes", "Your notes", None)];
    assert!(parse_reply("I can't help with that.", &gathered).is_none());
    assert!(parse_reply(r#"{"working_on":[],"interests":[]}"#, &gathered).is_none());
}

#[test]
fn the_prompt_numbers_evidence_and_marks_undated_items() {
    let prompt = user_prompt(
        "2026-10-18",
        &[
            gathered("Memory", "Agent memory", Some("2026-10-01")),
            gathered("Notes", "Plan", None),
        ],
    );
    assert!(prompt.starts_with("Today: 2026-10-18"));
    assert!(prompt.contains("[0] 2026-10-01 · Memory · Agent memory\nAgent memory details"));
    assert!(prompt.contains("[1] undated · Notes · Plan"));
}

#[test]
fn redaction_removes_contact_details_keys_and_paths() {
    let text = "Mail ada@example.test, see https://example.test/x from 10.1.2.3, key sk-abcdefghijklmnop, \
                id 123e4567-e89b-12d3-a456-426614174000, file /Users/example/notes.md on 2026-10-18";
    let out = redact::redact(text);
    for leaked in [
        "ada@", "https://", "10.1.2.3", "sk-abc", "123e4567", "/Users/",
    ] {
        assert!(!out.contains(leaked), "{leaked} leaked: {out}");
    }
    assert!(out.contains("2026-10-18"), "dates stay: {out}");
}

#[test]
fn redaction_covers_long_agent_markdown() {
    let block =
        "# Agent notes\n\n- Work in `~/code/kordi` and [docs](https://example.test/docs).\n\
                 - Ask ada@example.test; logs in /Users/example/logs.\n\
                 ```sh\nexport OPENAI_API_KEY=\"abc123abc123abc123\"\n\
                 curl -H \"Authorization: Bearer abcdefghijklmnopqrstuv\"\n\
                 git push github_pat_abcdefghijklmnop12 $HOME/work\n```\n\
                 Prefer small reviewed PRs.\n";
    let text = block.repeat(400);
    let out = redact::redact(&text);
    for leaked in [
        "~/code",
        "example.test",
        "/Users/",
        "abc123abc",
        "abcdefghijklmnopqrstuv",
        "github_pat_",
        "$HOME/",
    ] {
        assert!(!out.contains(leaked), "{leaked} leaked");
    }
    assert!(out.contains("OPENAI_API_KEY=[secret]"));
    assert_eq!(out.matches("Prefer small reviewed PRs.").count(), 400);
}

#[test]
fn links_are_recognized_without_fetching() {
    assert_eq!(
        build::link_url_for_tests("example.test/papers").as_deref(),
        Some("https://example.test/papers")
    );
    assert_eq!(
        build::link_url_for_tests("https://example.test").as_deref(),
        Some("https://example.test")
    );
    assert_eq!(build::link_url_for_tests("I work on agent memory."), None);
    assert_eq!(build::link_url_for_tests("v1.2"), None);
}

#[test]
fn room_codes_are_four_digits() {
    assert!(rooms::valid_code_for_tests("0427"));
    for bad in ["427", "04270", "04a7", "", "٠١٢٣"] {
        assert!(!rooms::valid_code_for_tests(bad), "{bad}");
    }
}

#[test]
fn pairing_codes_read_cleanly() {
    let code = pairing::new_code_for_tests();
    assert_eq!(code.len(), 8);
    assert!(!code.contains(['I', 'L', 'O', 'U']));
    assert_eq!(pairing::display_for_tests("ABCD2345"), "ABCD-2345");
    assert_eq!(pairing::normalize("abcd-o1il"), "ABCD0111");
    let _ = build::request_for_tests("", "");
}
