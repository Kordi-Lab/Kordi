use super::*;

const SESSION: &str = "session:group:grp_alpha";

fn run(owner_request: bool) -> MemoryRun<'static> {
    MemoryRun {
        session_id: SESSION,
        subsession_id: Some("sub_1"),
        owner_request,
    }
}

const ON: MemorySettings = MemorySettings {
    enabled: true,
    exclude_sensitive: true,
};

fn memory<'a>(scope: &'a str, scope_id: &'a str, text: &'a str, at: &'a str) -> PromptMemory<'a> {
    PromptMemory {
        scope,
        scope_id,
        text,
        created_at: at,
        updated_at: at,
    }
}

#[test]
fn scopes_follow_the_session_and_subsession() {
    let scopes = MemoryScopes::for_run(&run(true));
    assert_eq!(scopes.conversation_ids, vec![SESSION, "sub_1"]);
    assert_eq!(scopes.group_id.as_deref(), Some("grp_alpha"));
    assert!(scopes.applies("global", GLOBAL_SCOPE_ID));
    assert!(!scopes.applies("global", "acct_other"));
    assert!(scopes.applies("conversation", "sub_1"));
    assert!(scopes.applies("group", "grp_alpha"));
    assert!(!scopes.applies("group", "grp_other"));
    assert!(
        !scopes.applies("project", "proj_1"),
        "runs carry no project"
    );
    assert!(!scopes.applies("other", SESSION));

    let direct = MemoryScopes::for_session("session:direct-person:a:b", Some(" "));
    assert_eq!(direct.conversation_ids, vec!["session:direct-person:a:b"]);
    assert_eq!(direct.group_id, None);
    let same = MemoryScopes::for_session(SESSION, Some(SESSION));
    assert_eq!(same.conversation_ids, vec![SESSION]);
}

#[test]
fn saves_are_limited_to_the_run_scopes() {
    let scopes = MemoryScopes::for_run(&run(false));
    assert!(scopes.check_save(false, "group", "grp_alpha").is_ok());
    assert!(scopes.check_save(false, "conversation", " sub_1 ").is_ok());
    let refused = scopes.check_save(false, "global", "account").unwrap_err();
    assert_eq!(
        refused,
        "Memories from this run can only be saved in these scopes: conversation `session:group:grp_alpha`, conversation `sub_1`, group `grp_alpha`."
    );
    assert!(scopes.check_save(true, "global", "account").is_ok());
    let refused = scopes.check_save(true, "project", "proj_1").unwrap_err();
    assert!(refused.contains("global `account`, conversation"));
}

#[test]
fn the_section_orders_blocks_and_applies_both_caps() {
    let mut memories = vec![
        memory(
            "group",
            "grp_alpha",
            "Reports go out on Fridays.",
            "2026-10-04",
        ),
        memory(
            "global",
            "account",
            "Always  answer\nbriefly.",
            "2026-10-01",
        ),
        memory("global", "acct_other", "Not account wide.", "2026-10-05"),
        memory("project", "proj_1", "Project memory.", "2026-10-05"),
        memory("group", "grp_other", "Another group.", "2026-10-05"),
    ];
    let numbered: Vec<String> = (0..45)
        .map(|index| format!("Memory number {index:02}."))
        .collect();
    let stamps: Vec<String> = (0..45)
        .map(|index| format!("2026-10-02T00:00:{index:02}"))
        .collect();
    for (text, at) in numbered.iter().zip(&stamps) {
        memories.push(memory("conversation", SESSION, text, at));
    }
    let section = memory_prompt_section(&run(true), ON, &memories).unwrap();
    assert!(
        section
            .starts_with("## Memories\nMemories sync with the account and must not record health")
    );
    assert!(section.contains(&memory_routing_rules()));
    assert!(section.contains(
        "\nScope ids for this run: global `account`, conversation `session:group:grp_alpha`, group `grp_alpha`."
    ));
    let global = section.find("\nGlobal:\n- Always answer briefly.").unwrap();
    let conversation = section
        .find("\nThis conversation:\n- Memory number 44.")
        .unwrap();
    assert!(global < conversation);
    assert!(section.find("Memory number 44.") < section.find("Memory number 43."));
    assert_eq!(section.matches("\n- ").count(), MAX_PROMPT_MEMORIES);
    assert!(
        !section.contains("This group:"),
        "the count cap ends the list"
    );
    assert!(!section.contains("Not account wide."));
    assert!(!section.contains("Project memory."));
    assert!(section.ends_with("\n(more memories omitted)"));

    let long = "x".repeat(400);
    let many: Vec<PromptMemory<'_>> = stamps
        .iter()
        .take(30)
        .map(|at| memory("conversation", SESSION, &long, at))
        .collect();
    let section = memory_prompt_section(&run(true), ON, &many).unwrap();
    let shown = section.matches("\n- ").count();
    assert!(shown < 30);
    assert!(
        shown * 403 <= MAX_PROMPT_MEMORY_CHARS,
        "the character cap holds"
    );
    assert!(section.ends_with("(more memories omitted)"));
}

#[test]
fn settings_and_requester_change_the_wording() {
    let one = [memory(
        "group",
        "grp_alpha",
        "Ship on Fridays.",
        "2026-10-01",
    )];
    let open = MemorySettings {
        enabled: true,
        exclude_sensitive: false,
    };
    let section = memory_prompt_section(&run(false), open, &one).unwrap();
    assert!(section.starts_with("## Memories\nMemories sync with the account. They are current"));
    assert!(section.contains(
        "Scope ids for this run: conversation `session:group:grp_alpha`, group `grp_alpha`."
    ));
    assert!(section.ends_with("\nThis group:\n- Ship on Fridays."));
    let empty = memory_prompt_section(&run(true), ON, &[]).unwrap();
    assert!(!empty.contains("\n- "));
    assert!(!empty.contains("omitted"));
    let off = MemorySettings {
        enabled: false,
        exclude_sensitive: true,
    };
    assert_eq!(memory_prompt_section(&run(true), off, &one), None);
}

#[test]
fn a_tool_less_prompt_adds_the_section_and_the_no_tools_line() {
    assert_eq!(
        tool_less_system_prompt("  Rules \n", Some("## Memories\n- One.")),
        "Rules\n\n## Memories\n- One.\nThis run has no tools: apply the memories, do not try to save new ones."
    );
    assert_eq!(tool_less_system_prompt(" Rules ", None), "Rules");
}
