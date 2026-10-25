use super::*;

const SESSION: &str = "session:group:g1";

fn run(owner_request: bool) -> MemoryRun<'static> {
    MemoryRun {
        session_id: SESSION,
        subsession_id: None,
        owner_request,
    }
}

fn on() -> MemorySettings {
    MemorySettings {
        enabled: true,
        exclude_sensitive: true,
    }
}

fn memory<'a>(scope: &'a str, scope_id: &'a str, text: &'a str, at: &'a str) -> SearchMemory<'a> {
    SearchMemory {
        scope,
        scope_id,
        text,
        category: "work_context",
        created_at: at,
        updated_at: at,
    }
}

fn texts(found: &[SearchMemory<'_>]) -> Vec<String> {
    found.iter().map(|memory| memory.text.to_string()).collect()
}

#[test]
fn matches_rank_by_shared_words_then_by_recency() {
    let scripts = memory(
        "global",
        "account",
        "Maintains the lab's figure scripts in the shared repo and knows the dataset loaders.",
        "2026-10-01T00:00:00Z",
    );
    let captions = memory(
        "global",
        "account",
        "Wants figure captions in sentence case.",
        "2026-10-03T00:00:00Z",
    );
    let older_captions = memory(
        "global",
        "account",
        "Keeps figure sizes at 85 mm.",
        "2026-10-02T00:00:00Z",
    );
    let style = SearchMemory {
        category: "general_preferences",
        ..memory(
            "global",
            "account",
            "Answer in British English and keep replies short.",
            "2026-10-04T00:00:00Z",
        )
    };
    let all = [scripts, captions, older_captions, style];
    let found = search(
        &run(true),
        on(),
        &all,
        "Figure script fails in the dataset loader",
        5,
    );
    assert_eq!(
        texts(&found),
        vec![
            scripts.text.to_string(),
            captions.text.to_string(),
            older_captions.text.to_string(),
        ],
        "three shared words first, then the newest of the ties; no match is left out"
    );
    // The category counts too: `preferences` finds `general_preferences`.
    assert_eq!(
        texts(&search(&run(true), on(), &all, "preferences", 5)),
        vec![style.text.to_string()]
    );
    // A query with no words returns the newest memories.
    assert_eq!(
        search(&run(true), on(), &all, "  the  ", 2),
        vec![style, captions]
    );
}

#[test]
fn only_memories_the_run_may_read_are_searched() {
    let at = "2026-10-01T00:00:00Z";
    let all = [
        memory("global", "account", "Global deploy note.", at),
        memory("global", "elsewhere", "Malformed global deploy note.", at),
        memory("conversation", SESSION, "Conversation deploy note.", at),
        memory(
            "conversation",
            "session:group:g2",
            "Other conversation deploy note.",
            at,
        ),
        memory("group", "g1", "Group deploy note.", at),
        memory("group", "g2", "Other group deploy note.", at),
        memory("project", "p1", "Project deploy note.", at),
    ];
    let mut found = texts(&search(&run(false), on(), &all, "deploy", 10));
    found.sort();
    assert_eq!(
        found,
        vec![
            "Conversation deploy note.",
            "Global deploy note.",
            "Group deploy note."
        ]
    );
}

#[test]
fn memory_off_finds_nothing() {
    let all = [memory(
        "global",
        "account",
        "Deploys on Fridays.",
        "2026-10-01",
    )];
    let off = MemorySettings {
        enabled: false,
        exclude_sensitive: true,
    };
    assert!(search(&run(true), off, &all, "deploys", 5).is_empty());
    assert_eq!(search(&run(true), on(), &all, "deploys", 5).len(), 1);
}

#[test]
fn sensitive_memories_stay_out_while_the_account_excludes_them() {
    let all = [
        memory(
            "global",
            "account",
            "Was diagnosed with asthma and runs the inhaler study scripts.",
            "2026-10-02",
        ),
        memory(
            "global",
            "account",
            "Runs the study scripts on Mondays.",
            "2026-10-01",
        ),
    ];
    assert_eq!(
        texts(&search(&run(true), on(), &all, "study scripts", 5)),
        vec!["Runs the study scripts on Mondays."]
    );
    let allowed = MemorySettings {
        enabled: true,
        exclude_sensitive: false,
    };
    assert_eq!(
        search(&run(true), allowed, &all, "study scripts", 5).len(),
        2
    );
}

#[test]
fn the_limit_is_five_by_default_and_ten_at_most() {
    let texts: Vec<String> = (0..12)
        .map(|index| format!("Deploy note {index}."))
        .collect();
    let all: Vec<SearchMemory<'_>> = texts
        .iter()
        .map(|text| memory("global", "account", text, "2026-10-01"))
        .collect();
    let (query, limit) = arguments(&json!({"query": "deploy"})).unwrap();
    assert_eq!(limit, 5);
    assert_eq!(search(&run(true), on(), &all, &query, limit).len(), 5);
    let (_, limit) = arguments(&json!({"query": "deploy", "limit": 50})).unwrap();
    assert_eq!(limit, 10);
    assert_eq!(search(&run(true), on(), &all, "deploy", limit).len(), 10);
    assert_eq!(search(&run(true), on(), &all, "deploy", 0).len(), 1);
    assert_eq!(
        arguments(&json!({"limit": 3})),
        Err(SearchError::Invalid("query is required."))
    );
}

#[test]
fn only_proactive_runs_carry_the_read_only_tool() {
    for run_id in ["proactive_eval_1", "proactive_run_pro_1"] {
        let tools = lease_tools(run_id);
        assert_eq!(tools.len(), 1, "{run_id}");
        assert_eq!(tools[0].connector_id, MEMORY_CONNECTOR_ID);
        assert_eq!(tools[0].name, SEARCH_MEMORY_TOOL);
        assert_eq!(tools[0].group, ConnectorToolGroup::Read);
    }
    assert!(lease_tools("car_1").is_empty());
    assert!(lease_tools("digest_1").is_empty());
    let tool = mac_tool();
    assert_eq!(tool["name"], SEARCH_MEMORY_TOOL);
    assert_eq!(tool["parameters"]["required"], json!(["query"]));
    assert!(tool["description"]
        .as_str()
        .unwrap()
        .contains("never quote or mention them"));
}
