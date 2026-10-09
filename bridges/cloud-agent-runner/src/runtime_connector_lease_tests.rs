//! Lease parsing and the tools the cloud runner offers from a lease.

use super::*;

#[test]
fn offered_tools_skip_built_ins_bad_shapes_and_repeats() {
    let mut repeat = descriptor("gmail_search", ConnectorToolGroup::Read);
    repeat.description = "a second gmail_search".into();
    let tools = vec![
        descriptor("gmail.search", ConnectorToolGroup::Read),
        descriptor("gmail_search", ConnectorToolGroup::Read),
        repeat,
        descriptor("export_artifact", ConnectorToolGroup::Read),
    ];
    // The policy itself refuses a lease name that is a built-in tool.
    assert_eq!(
        decide_runner_tool(&request("export_artifact", &tools)),
        RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
    );
    let run = run("person_started", tools);
    let names = connectors::tool_definitions(&run)
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    // The owner-private run also offers the connect link.
    assert_eq!(names, ["gmail_search", "connectors_request_connect"]);
    let prompt = connectors::prompt_section(&run).unwrap();
    assert_eq!(prompt.matches("\n- ").count(), 1, "{prompt}");
    assert!(prompt.contains("- gmail_search: gmail_search description"));
    assert!(!prompt.contains("export_artifact") && !prompt.contains("gmail.search"));
}

#[test]
fn a_bad_lease_entry_drops_only_itself() {
    let lease = json!({
        "runId": "car_1", "status": "leased", "prompt": "p",
        "ownerAccountId": "a", "requesterAccountId": "a", "sessionId": "s",
        "sandboxId": null, "providerAuthAvailable": false,
        "trigger": "person_started",
        "connectorTools": [
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_search",
             "group": "read", "description": "Search mail."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_watch",
             "group": "stream", "description": "Unknown group."},
            {"name": "missing_fields"},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_send",
             "group": "act", "description": "Send mail."}
        ]
    });
    let run: CloudAgentRun = serde_json::from_value(lease).unwrap();
    let names = run
        .connectors
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, ["gmail_search", "gmail_send"]);
}
