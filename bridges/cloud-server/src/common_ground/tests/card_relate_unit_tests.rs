//! Replies of card builds that relate memories (#2069): `relatedMemoryIds`
//! is optional, and only offered ids count.

use serde_json::json;

use super::super::build::{related_ids, user_block, Candidate};
use super::super::prompt::{parse_reply, Gathered};

fn gathered() -> Vec<Gathered> {
    vec![Gathered {
        source: "Memory".into(),
        title: "Leads the Atlas data pipeline".into(),
        date: Some("2026-10-01".into()),
        url: None,
        text: "Leads the Atlas data pipeline".into(),
    }]
}

const CARD: &str = r#""working_on":[{"label":"Atlas data pipeline","evidence":[0]}]"#;

#[test]
fn replies_parse_with_and_without_related_memories() {
    let offered = json!(["mem_a", "mem_b", "mem_c"]);
    let without = format!("{{{CARD}}}");
    let (topics, _) = parse_reply(&without, &gathered()).unwrap();
    assert_eq!(topics.working_on, ["Atlas data pipeline"]);
    assert!(related_ids(&without, &offered).is_empty());

    let with = format!(
        r#"Here it is: {{{CARD},"relatedMemoryIds":["mem_b"," mem_a ","mem_b","mem_zzz",7,"mem_c"]}}"#
    );
    let (topics, _) = parse_reply(&with, &gathered()).unwrap();
    assert_eq!(topics.working_on, ["Atlas data pipeline"]);
    assert_eq!(related_ids(&with, &offered), ["mem_b", "mem_a", "mem_c"]);

    // Nothing offered, nothing related; a reply that is not JSON relates
    // nothing.
    assert!(related_ids(&with, &json!(null)).is_empty());
    assert!(related_ids("relatedMemoryIds: mem_a", &offered).is_empty());
}

#[test]
fn related_memories_are_capped() {
    let ids: Vec<String> = (0..30).map(|i| format!("mem_{i}")).collect();
    let reply = json!({ "working_on": [], "relatedMemoryIds": ids }).to_string();
    let related = related_ids(&reply, &json!(ids));
    assert_eq!(related.len(), 15);
    assert_eq!(related[0], "mem_0");
}

#[test]
fn offered_memories_are_listed_with_their_ids() {
    let block = user_block(&[Candidate {
        id: "mem_a".into(),
        text: "Prefers short replies".into(),
        category: "general_preferences".into(),
    }]);
    assert_eq!(
        block,
        "\nOther memories:\n[mem_a] general_preferences · Prefers short replies\n"
    );
}
