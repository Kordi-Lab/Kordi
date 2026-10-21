use serde_json::json;

use crate::common_ground::card::Topics;
use crate::common_ground::matching::prompt::{
    match_prompt, parse_matches, parse_themes, room_prompt, Found,
};
use crate::common_ground::matching::{headline, score, suggestion, Reason, SharedCard, Trade};

fn card(
    id: &str,
    working_on: &[&str],
    interests: &[&str],
    can_help: &[&str],
    looking_for: &[&str],
) -> SharedCard {
    let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
    SharedCard {
        account_id: id.into(),
        profile_id: format!("cgp_{id}"),
        profile_kind: "work".into(),
        profile_name: "Work".into(),
        name: id.into(),
        avatar_url: None,
        revision: 1,
        topics: Topics {
            working_on: list(working_on),
            interests: list(interests),
            can_help: list(can_help),
            looking_for: list(looking_for),
            ..Topics::default()
        },
    }
}

fn viewer() -> SharedCard {
    card(
        "you",
        &["Agent memory"],
        &["Retrieval"],
        &["Eval design"],
        &["GPU access"],
    )
}

fn other() -> SharedCard {
    card(
        "Priya",
        &["Memory for agents"],
        &["Speech"],
        &["GPU clusters"],
        &["Eval design help"],
    )
}

#[test]
fn prompts_list_cards_by_number() {
    let prompt = match_prompt(&viewer(), &[other()]);
    assert!(prompt.starts_with("Your card:\n  Working on: Agent memory\n"));
    assert!(prompt.contains("[0] Priya\n  Working on: Memory for agents\n"));
    assert!(prompt.contains("  Looking for: Eval design help\n"));
    let room = room_prompt(&[viewer(), other()]);
    assert_eq!(
        room,
        "People in the room:\n[0] Agent memory; Retrieval\n[1] Memory for agents; Speech\n"
    );
}

#[test]
fn replies_may_only_use_labels_from_the_right_card_and_list() {
    let reply = json!({"people": [{"person": 0,
        "shared": [
            {"mine": "Eval design", "theirs": "Memory for agents", "why": "can help is not shared ground"},
            {"mine": "agent memory", "theirs": "memory FOR agents", "why": "  Both   study memory "},
            {"mine": "Agent memory", "theirs": "Speech", "why": "each topic pairs once"}],
        "you_bring": [{"topic": "Eval design", "for": "Eval design help", "why": "x"},
                      {"topic": "Retrieval", "for": "Speech", "why": "not a skill you listed"}],
        "they_bring": [{"topic": "GPU clusters", "for": "Memory for agents", "why": "their own topic"}],
        "next_step": "Meet"}]})
    .to_string();
    let found = parse_matches(
        &format!("Sure:\n```json\n{reply}\n```"),
        &viewer(),
        &[other()],
    )
    .unwrap();
    assert_eq!(
        found[0].shared,
        vec![Reason {
            topic: "Agent memory".into(),
            their_topic: "Memory for agents".into(),
            why: "Both study memory".into()
        }]
    );
    assert_eq!(found[0].you_bring.len(), 1);
    assert!(
        found[0].they_bring.is_empty(),
        "a trade must serve the other side"
    );
    assert_eq!(found[0].next_step, "Meet");
}

#[test]
fn people_left_out_have_nothing_in_common_and_bad_replies_fail() {
    let sam = card("Sam", &["Robot grasping"], &[], &[], &[]);
    let found = parse_matches(
        r#"{"people":[{"person":5},{"person":1}]}"#,
        &viewer(),
        &[other(), sam.clone()],
    )
    .unwrap();
    assert_eq!(found, vec![Found::default(), Found::default()]);
    let empty = parse_matches(
        r#"{"people":[{"person":0,"next_step":"Say hi"}]}"#,
        &viewer(),
        &[other()],
    )
    .unwrap();
    assert_eq!(empty[0].next_step, "", "no next step without common ground");
    assert!(parse_matches("I can't help with that.", &viewer(), &[other()]).is_none());
}

#[test]
fn a_reply_that_names_nobody_fails_the_run() {
    for reply in [
        "{}",
        r#"{"people":[]}"#,
        r#"{"people":[{"person":7}]}"#,
        r#"{"people":{"person":0}}"#,
    ] {
        assert!(
            parse_matches(reply, &viewer(), &[other()]).is_none(),
            "{reply}"
        );
    }
    assert_eq!(
        parse_matches(r#"{"people":[]}"#, &viewer(), &[]),
        Some(vec![]),
        "an empty batch has nobody to name"
    );
}

#[test]
fn the_first_entry_for_a_person_wins() {
    let reply = json!({"people": [
        {"person": 0, "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": "first"}], "next_step": "Meet"},
        {"person": 0, "shared": [], "next_step": ""},
    ]})
    .to_string();
    let found = parse_matches(&reply, &viewer(), &[other()]).unwrap();
    assert_eq!(found[0].shared.len(), 1);
    assert_eq!(found[0].shared[0].why, "first");
    assert_eq!(found[0].next_step, "Meet");
}

#[test]
fn labels_match_ignoring_spacing_on_the_card_too() {
    let spaced = card(
        "Priya",
        &["Memory  for\tagents"],
        &[],
        &["GPU   clusters"],
        &[],
    );
    let reply = json!({"people": [{"person": 0,
        "shared": [{"mine": "Agent memory", "theirs": "memory for agents", "why": "x"}],
        "they_bring": [{"topic": "gpu clusters", "for": "GPU access", "why": "y"}]}]})
    .to_string();
    let found = parse_matches(&reply, &viewer(), &[spaced]).unwrap();
    assert_eq!(found[0].shared[0].their_topic, "Memory  for\tagents");
    assert_eq!(found[0].they_bring[0].topic, "GPU   clusters");
}

#[test]
fn themes_need_two_people_and_come_largest_first() {
    let reply = r#"{"themes":[{"label":"Solo","people":[0]},{"label":"Pair","people":[0,1,1,9]},{"label":" Trio ","people":[0,1,2]},{"label":"","people":[0,1]}]}"#;
    let themes = parse_themes(reply, 3).unwrap();
    assert_eq!(
        themes,
        vec![
            ("Trio".to_string(), vec![0, 1, 2]),
            ("Pair".to_string(), vec![0, 1])
        ]
    );
    assert!(parse_themes("no", 3).is_none());
    assert!(
        parse_themes("{}", 3).is_none(),
        "a reply without themes is not a theme list"
    );
    assert_eq!(parse_themes(r#"{"themes":[]}"#, 3), Some(vec![]));
}

#[test]
fn scores_weigh_shared_work_and_needs_met() {
    let (you, them) = (viewer(), other());
    let shared = Found {
        shared: vec![Reason {
            topic: "Agent memory".into(),
            their_topic: "Memory for agents".into(),
            why: String::new(),
        }],
        ..Found::default()
    };
    let trade = |topic: &str, target: &str| Trade {
        topic: topic.into(),
        target: target.into(),
        why: String::new(),
    };
    let both = Found {
        you_bring: vec![trade("Eval design", "Eval design help")],
        they_bring: vec![trade("GPU clusters", "GPU access")],
        ..shared.clone()
    };
    let interests_only = Found {
        shared: vec![Reason {
            topic: "Retrieval".into(),
            their_topic: "Speech".into(),
            why: String::new(),
        }],
        ..Found::default()
    };
    assert_eq!(score(&you.topics, &them.topics, &Found::default()), 0);
    assert_eq!(score(&you.topics, &them.topics, &shared), 38);
    assert_eq!(score(&you.topics, &them.topics, &both), 73);
    assert!(
        score(&you.topics, &them.topics, &interests_only) < 38,
        "work counts more than interests"
    );
    assert_eq!(headline(&shared), "Memory for agents");
    assert_eq!(
        headline(&Found {
            they_bring: vec![trade("GPU clusters", "GPU access")],
            ..Found::default()
        }),
        "Can help with GPU clusters"
    );
    assert_eq!(
        headline(&Found {
            you_bring: vec![trade("Eval design", "x")],
            ..Found::default()
        }),
        "Needs your Eval design"
    );
    assert_eq!(headline(&Found::default()), "Different area");
}

#[test]
fn the_suggestion_prefers_a_group_of_three_with_you() {
    let theme = |label: &str, people: &[&str]| {
        (
            label.to_string(),
            people.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
        )
    };
    let themes = vec![
        theme("Big", &["a", "b", "c", "d"]),
        theme("Pair", &["you", "a"]),
        theme("Trio", &["you", "a", "b"]),
    ];
    assert_eq!(suggestion(&themes, "you").unwrap().0, "Trio");
    assert_eq!(suggestion(&themes[..2], "you").unwrap().0, "Pair");
    assert!(suggestion(&themes[..1], "you").is_none());
}
