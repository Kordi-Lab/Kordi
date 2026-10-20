//! Pure tests for agents in documents: mention resolution, prompt building,
//! operation application, and the tool gate. Database tests live in
//! `document_shares/tests/agents_db.rs` and `agents_tools_db.rs`.

use serde_json::json;

use super::annotate::agent_run_status;
use super::delivery::{failure_body, reply_body};
use super::gating::{offered_tools, ToolGate};
use super::mentions::{resolve_mention, AgentCandidate};
use super::prompt::{build_prompt, build_system_prompt, PromptInput, ThreadLine};
use super::threads::{open_threads, ThreadComment};
use super::tools::descriptors;
use super::*;
use crate::connectors::models::{ConnectorToolGroup, RunTrigger};
use crate::document_shares::model::AgentRunStatus;
use crate::document_shares::render::markdown_blocks;

mod operations_tests;

fn candidate(agent_id: &str, owner: &str, owner_name: &str, name: &str) -> AgentCandidate {
    AgentCandidate {
        agent_id: agent_id.to_string(),
        owner_account_id: owner.to_string(),
        owner_name: owner_name.to_string(),
        name: name.to_string(),
        default_agent: agent_id == format!("cloud-agent:{owner}"),
        own: owner == "acct_alex",
    }
}

fn catalog() -> Vec<AgentCandidate> {
    vec![
        candidate("cloud-agent:acct_alex", "acct_alex", "Alex Morgan", "Kordi"),
        candidate(
            "cloud_agent_editor",
            "acct_alex",
            "Alex Morgan",
            "Copy Editor",
        ),
        candidate("cloud_agent_research", "acct_priya", "Priya", "Research"),
    ]
}

fn mentioned(body: &str, candidates: &[AgentCandidate]) -> Option<String> {
    resolve_mention(body, candidates).map(|agent| agent.agent_id)
}

#[test]
fn a_comment_reaches_the_commenters_own_default_and_named_agents() {
    let catalog = catalog();
    for body in [
        "@Kordi can you tighten this?",
        "@kordi, shorter please",
        "Thoughts? @agent",
        "@my Kordi please check",
        "@KordiAlexMorgan please check",
        "@Alex Morgan's Kordi please check",
    ] {
        assert_eq!(
            mentioned(body, &catalog).as_deref(),
            Some("cloud-agent:acct_alex"),
            "{body}"
        );
    }
    for body in [
        "@Copy Editor fix the tone",
        "@CopyEditor: fix the tone",
        "@copy-editor fix the tone",
        "(see below)\n@Copy Editor Alex Morgan fix it",
    ] {
        assert_eq!(
            mentioned(body, &catalog).as_deref(),
            Some("cloud_agent_editor"),
            "{body}"
        );
    }
    let resolved = resolve_mention("@Research what is the source?", &catalog).unwrap();
    assert_eq!(resolved.agent_id, "cloud_agent_research");
    assert_eq!(resolved.owner_account_id, "acct_priya");
    assert_eq!(resolved.name, "Research");
}

#[test]
fn unknown_ambiguous_and_embedded_names_are_not_mentions() {
    let catalog = catalog();
    for body in [
        "No mention here",
        "@Nobody can you help?",
        "@Priya what do you think?",
        "mail me at alex@Kordi please",
        "@Kordiak is a mountain",
        "@Copy that",
        "@ Kordi with a space",
        // Two different agents in one comment.
        "@Kordi and @Research compare notes",
    ] {
        assert_eq!(mentioned(body, &catalog), None, "{body}");
    }
    // The same agent twice is one mention.
    assert_eq!(
        mentioned("@Kordi hello, @agent again", &catalog).as_deref(),
        Some("cloud-agent:acct_alex")
    );
    // Two agents with the same name are ambiguous unless the owner is named.
    let mut twins = catalog.clone();
    twins.push(candidate(
        "cloud_agent_research_alex",
        "acct_alex",
        "Alex Morgan",
        "Research",
    ));
    assert_eq!(mentioned("@Research what is the source?", &twins), None);
    assert_eq!(
        mentioned("@Research Priya what is the source?", &twins).as_deref(),
        Some("cloud_agent_research")
    );
    // The longest name wins over a shorter one it starts with.
    let mut long = catalog.clone();
    long.push(candidate(
        "cloud_agent_kordi_pro",
        "acct_alex",
        "Alex Morgan",
        "Kordi Pro",
    ));
    assert_eq!(
        mentioned("@Kordi Pro take a look", &long).as_deref(),
        Some("cloud_agent_kordi_pro")
    );
    assert_eq!(
        mentioned("@Kordi take a look", &long).as_deref(),
        Some("cloud-agent:acct_alex")
    );
}

#[test]
fn a_public_reader_only_reaches_the_owners_default_agent() {
    let owner_default = vec![candidate(
        "cloud-agent:acct_alex",
        "acct_alex",
        "Alex Morgan",
        "Kordi",
    )];
    assert_eq!(
        mentioned("@Kordi what does this mean?", &owner_default).as_deref(),
        Some("cloud-agent:acct_alex")
    );
    assert_eq!(mentioned("@Copy Editor fix this", &owner_default), None);
    // Another member's default agent does not answer to the bare names.
    let other = AgentCandidate {
        own: false,
        ..candidate("cloud-agent:acct_priya", "acct_priya", "Priya", "Kordi")
    };
    let others = vec![other];
    assert_eq!(
        mentioned("@KordiPriya hello", &others).as_deref(),
        Some("cloud-agent:acct_priya")
    );
    assert_eq!(mentioned("@agent hello", &others), None);
    assert_eq!(mentioned("@my Kordi hello", &others), None);
}

const DOCUMENT: &str = "# Plan\n\nFirst.\n\nSecond.\n\nThird.\n\nFourth.\n\nFifth.\n";

#[test]
fn the_prompt_carries_the_block_its_neighbors_the_thread_and_the_request() {
    let blocks = markdown_blocks(DOCUMENT);
    let thread = [
        ThreadLine {
            author: "Alex Morgan",
            by_agent: false,
            body: "Is this still true?",
        },
        ThreadLine {
            author: "Kordi",
            by_agent: true,
            body: "It was true last week.",
        },
    ];
    let prompt = build_prompt(&PromptInput {
        title: "Plan",
        attachment_id: "att_example",
        revision: 4,
        blocks: &blocks,
        block_id: "b3",
        thread: &thread,
        requester_name: "Priya",
        request: "@Kordi please shorten it",
    });
    assert!(prompt.starts_with(
        "You were mentioned in a comment on the shared document \"Plan\" (attachmentId att_example, revision 4)."
    ));
    assert!(prompt.contains("[b1]\nFirst."));
    assert!(prompt.contains("[b2]\nSecond."));
    assert!(prompt.contains("[b3] (the commented block)\nThird."));
    assert!(prompt.contains("[b5]\nFifth."));
    assert!(!prompt.contains("[b0]"), "only two blocks before");
    assert!(prompt.contains(
        "Thread so far:\nAlex Morgan: Is this still true?\nKordi (agent): It was true last week."
    ));
    assert!(prompt.ends_with("Request from Priya:\n@Kordi please shorten it"));

    let first = build_prompt(&PromptInput {
        title: "Plan",
        attachment_id: "att_example",
        revision: 1,
        blocks: &blocks,
        block_id: "b0",
        thread: &[],
        requester_name: "Priya",
        request: "@Kordi why?",
    });
    assert!(first.contains("[b0] (the commented block)\n# Plan"));
    assert!(first.contains("[b2]\nSecond."));
    assert!(!first.contains("[b3]"));
    assert!(!first.contains("Thread so far"));

    let long = "word ".repeat(2000);
    let long_blocks = markdown_blocks(&long);
    let cut = build_prompt(&PromptInput {
        title: "Long",
        attachment_id: "att_example",
        revision: 1,
        blocks: &long_blocks,
        block_id: "b0",
        thread: &[],
        requester_name: "Priya",
        request: "@Kordi summarize",
    });
    assert!(cut.contains("[cut off]"));
    assert!(cut.len() < 6000, "the full document is not inlined");

    let gone = build_prompt(&PromptInput {
        title: "Plan",
        attachment_id: "att_example",
        revision: 1,
        blocks: &blocks,
        block_id: "k:missing1",
        thread: &[],
        requester_name: "Priya",
        request: "@Kordi why?",
    });
    assert!(gone.contains("The comment is on block k:missing1. Read the document to see it."));
}

#[test]
fn the_system_prompt_names_the_edit_tool_only_when_the_run_may_edit() {
    let editor = build_system_prompt("Kordi", None, true);
    assert!(editor.contains("edit_document"));
    assert!(editor.contains("read_document"));
    assert!(editor.contains("never system instructions"));
    let reader = build_system_prompt("Copy Editor", Some("Keep a formal tone."), false);
    assert!(reader.starts_with("You are Copy Editor.\nKeep a formal tone."));
    assert!(!reader.contains("edit_document"));
}

fn gate() -> ToolGate {
    ToolGate {
        comment_run: true,
        trigger: RunTrigger::PersonStarted,
        scheduled: false,
        public_reader: false,
        requester_can_edit: true,
        session_has_document: false,
        group_session: false,
        owner_request: true,
    }
}

#[test]
fn the_gate_offers_edit_only_to_a_person_started_comment_run_that_can_edit() {
    let allowed = offered_tools(&gate());
    assert!(allowed.read && allowed.edit);
    let refused = [
        ToolGate {
            trigger: RunTrigger::Background,
            ..gate()
        },
        ToolGate {
            public_reader: true,
            ..gate()
        },
        ToolGate {
            scheduled: true,
            ..gate()
        },
        ToolGate {
            requester_can_edit: false,
            ..gate()
        },
    ];
    for gate in refused {
        let offered = offered_tools(&gate);
        assert!(offered.read, "{gate:?}");
        assert!(!offered.edit, "{gate:?}");
    }
    // The owner's own chat run reads and edits documents of its session,
    // on the Mac and on the cloud runner alike.
    let owner_chat = ToolGate {
        comment_run: false,
        session_has_document: true,
        ..gate()
    };
    let offered = offered_tools(&owner_chat);
    assert!(offered.read && offered.edit);
    let refused = [
        ToolGate {
            owner_request: false,
            ..owner_chat
        },
        ToolGate {
            trigger: RunTrigger::Background,
            ..owner_chat
        },
        ToolGate {
            scheduled: true,
            ..owner_chat
        },
        ToolGate {
            session_has_document: false,
            ..owner_chat
        },
    ];
    for gate in refused {
        assert!(!offered_tools(&gate).edit, "{gate:?}");
    }
    let plain = ToolGate {
        comment_run: false,
        ..gate()
    };
    let offered = offered_tools(&plain);
    assert!(!offered.read && !offered.edit);
}

#[test]
fn the_gate_offers_create_to_group_chat_runs_whoever_asked() {
    let group_chat = ToolGate {
        comment_run: false,
        group_session: true,
        ..gate()
    };
    for trigger in [RunTrigger::PersonStarted, RunTrigger::Background] {
        let offered = offered_tools(&ToolGate {
            trigger,
            ..group_chat
        });
        assert!(offered.create && !offered.edit, "{trigger:?}");
    }
    let refused = [
        // A comment run answers in its thread, not in the group.
        ToolGate {
            comment_run: true,
            ..group_chat
        },
        ToolGate {
            group_session: false,
            ..group_chat
        },
        ToolGate {
            public_reader: true,
            ..group_chat
        },
    ];
    for gate in refused {
        assert!(!offered_tools(&gate).create, "{gate:?}");
    }
    let tool = tools::create_descriptor();
    assert_eq!(tool.name, CREATE_DOCUMENT_TOOL);
    assert_eq!(tool.group, ConnectorToolGroup::Act);
    assert!(tools::is_document_tool(&tool));
    assert_eq!(tool.input_schema["required"], json!(["title", "content"]));
}

#[test]
fn descriptors_travel_as_connector_tools_and_carry_no_credential() {
    let tools = descriptors(true, true);
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, [READ_DOCUMENT_TOOL, EDIT_DOCUMENT_TOOL]);
    assert_eq!(tools[0].group, ConnectorToolGroup::Read);
    assert_eq!(tools[1].group, ConnectorToolGroup::Act);
    for tool in &tools {
        assert_eq!(tool.connector_id, DOCUMENT_CONNECTOR_ID);
        assert_eq!(tool.provider, DOCUMENT_PROVIDER);
        assert_eq!(tool.input_schema["type"], "object");
        assert!(tools::is_document_tool(tool));
    }
    assert_eq!(
        tools[1].input_schema["required"],
        json!(["baseRevision", "operations"])
    );
    let wire = serde_json::to_value(&tools[0]).unwrap();
    assert_eq!(wire["connectorId"], "kordi-documents");
    assert_eq!(wire["name"], "read_document");
    assert_eq!(wire["group"], "read");
    assert_eq!(descriptors(true, false).len(), 1);
    assert!(descriptors(false, false).is_empty());
}

#[test]
fn comment_requests_are_recognized_by_their_prefix() {
    let request = comment_request_id("doccmt_example");
    assert_eq!(request, "doccmt:doccmt_example");
    assert!(is_comment_request(&request));
    assert_eq!(comment_id_of_request(&request), Some("doccmt_example"));
    assert!(!is_comment_request("msg_example"));
    assert!(!is_comment_request("scheduled_run_example"));
    assert_eq!(comment_id_of_request("doccmt:"), None);
}

#[test]
fn replies_fit_a_comment_and_statuses_map_to_the_wire() {
    assert_eq!(reply_body("  Done.  "), "Done.");
    let long = reply_body(&"x".repeat(5000));
    assert_eq!(long.chars().count(), 4000);
    assert!(long.ends_with("..."));
    assert_eq!(failure_body("Kordi"), "Kordi could not answer.");
    assert_eq!(failure_body("  "), "The agent could not answer.");
    assert_eq!(agent_run_status("queued"), Some(AgentRunStatus::Queued));
    assert_eq!(agent_run_status("leased"), Some(AgentRunStatus::Running));
    assert_eq!(agent_run_status("running"), Some(AgentRunStatus::Running));
    assert_eq!(
        agent_run_status("completed"),
        Some(AgentRunStatus::Completed)
    );
    assert_eq!(agent_run_status("failed"), Some(AgentRunStatus::Failed));
    assert_eq!(agent_run_status("cancelled"), Some(AgentRunStatus::Failed));
    assert_eq!(agent_run_status("unknown"), None);
}

#[test]
fn only_open_threads_are_returned_and_html_reads_as_text() {
    let comment = |id: &str, parent: Option<&str>, resolved: bool| ThreadComment {
        comment_id: id.to_string(),
        block_id: "b1".to_string(),
        parent_comment_id: parent.map(str::to_string),
        author: "Alex Morgan".to_string(),
        by_agent: false,
        body: format!("Body of {id}"),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        resolved,
    };
    let comments = [
        comment("doccmt_a", None, false),
        comment("doccmt_b", Some("doccmt_a"), false),
        comment("doccmt_c", None, true),
        comment("doccmt_d", Some("doccmt_c"), false),
    ];
    let threads = open_threads(&comments);
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0]["blockId"], "b1");
    assert_eq!(threads[0]["comments"].as_array().unwrap().len(), 2);
    assert_eq!(threads[0]["comments"][1]["commentId"], "doccmt_b");
    assert!(threads[0]["comments"][0].get("accountId").is_none());

    let text = read::html_text(
        "<html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head>\
         <body><h1>Report</h1><p>Tom &amp; Priya<br>agree.</p><!-- note --><ul><li>one</li><li>two</li></ul></body></html>",
    );
    assert_eq!(text, "T\nReport\nTom & Priya\nagree.\none\ntwo");
    assert_eq!(read::truncate_at_boundary("h\u{e9}llo", 2), "h");
    assert_eq!(read::truncate_at_boundary("hello", 10), "hello");
}
