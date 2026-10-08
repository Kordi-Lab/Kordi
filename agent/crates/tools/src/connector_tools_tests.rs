use std::sync::{Arc, Mutex};

use super::*;
use crate::{ExecutionPolicy, ToolApprovalDecision, ToolApprovalOutcome};

fn descriptor(name: &str, group: ConnectorToolGroup) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: "conn_1".into(),
        provider: "gmail".into(),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: json!({"type":"object","properties":{"q":{"type":"string"}}}),
    }
}

fn runtime(calls: Arc<Mutex<Vec<String>>>) -> ConnectorToolsRuntime {
    ConnectorToolsRuntime {
        descriptors: vec![
            descriptor("gmail_search", ConnectorToolGroup::Read),
            descriptor("gmail_send", ConnectorToolGroup::Act),
        ],
        call: Arc::new(move |descriptor, args| {
            calls
                .lock()
                .unwrap()
                .push(format!("{}:{args}", descriptor.name));
            Box::pin(async move { Ok(json!({"ok": true, "tool": descriptor.name})) })
        }),
    }
}

fn context(
    connector_tools: Option<ConnectorToolsRuntime>,
    approvals: Option<(Arc<Mutex<Vec<String>>>, ToolApprovalDecision)>,
) -> ToolContext {
    ToolContext {
        cwd: std::env::temp_dir(),
        artifacts_dir: std::env::temp_dir(),
        connector_tools,
        request_approval: approvals.map(|(seen, decision)| {
            Arc::new(move |request: ToolApprovalRequest| {
                seen.lock().unwrap().push(request.tool_name);
                Box::pin(async move { ToolApprovalOutcome { decision } })
                    as crate::types::ToolApprovalFuture
            }) as crate::RequestToolApprovalFn
        }),
        ..Default::default()
    }
}

#[test]
fn descriptors_parse_from_the_lease_shape() {
    let parsed: ConnectorToolDescriptor = serde_json::from_value(json!({
        "connectorId": "conn_1", "provider": "github", "name": "github_notifications",
        "group": "read", "description": "List notifications."
    }))
    .unwrap();
    assert_eq!(parsed.group, ConnectorToolGroup::Read);
    assert_eq!(parsed.input_schema, json!({"type":"object"}));
    let tool = ConnectorTool::new(parsed);
    assert_eq!(tool.name(), "github_notifications");
    assert_eq!(tool.metadata().risk, ToolRiskLevel::ReadOnly);
    assert!(!tool.allows_shared_requests());
}

#[tokio::test]
async fn connector_tool_fails_closed_without_a_runtime_or_descriptor() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let tool = ConnectorTool::new(descriptor("gmail_search", ConnectorToolGroup::Read));
    let error = tool
        .execute(json!({}), &context(None, None), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not available"));

    let missing = ConnectorTool::new(descriptor("gmail_delete", ConnectorToolGroup::Read));
    let ctx = context(Some(runtime(calls.clone())), None);
    assert!(
        missing
            .execute(json!({}), &ctx, CancellationToken::new())
            .await
            .is_err()
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn read_tools_call_the_broker_and_return_its_result() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let ctx = context(Some(runtime(calls.clone())), None);
    let tool = ConnectorTool::new(descriptor("gmail_search", ConnectorToolGroup::Read));
    let result = tool
        .execute(json!({"q":"invoices"}), &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result.details,
        Some(json!({"ok": true, "tool": "gmail_search"}))
    );
    assert_eq!(*calls.lock().unwrap(), [r#"gmail_search:{"q":"invoices"}"#]);
}

#[tokio::test]
async fn act_tools_always_ask_first_and_refuse_without_approval() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let act = ConnectorTool::new(descriptor("gmail_send", ConnectorToolGroup::Act));

    // No approval hook: refused, nothing sent.
    let ctx = context(Some(runtime(calls.clone())), None);
    let error = act
        .execute(json!({}), &ctx, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Nothing was changed"));

    // Declined: refused, nothing sent.
    let seen = Arc::new(Mutex::new(Vec::new()));
    let ctx = context(
        Some(runtime(calls.clone())),
        Some((seen.clone(), ToolApprovalDecision::Denied)),
    );
    assert!(
        act.execute(json!({}), &ctx, CancellationToken::new())
            .await
            .is_err()
    );
    assert!(calls.lock().unwrap().is_empty());

    // Approved: the hook fired once and the call went through.
    let ctx = context(
        Some(runtime(calls.clone())),
        Some((seen.clone(), ToolApprovalDecision::ApprovedOnce)),
    );
    act.execute(json!({"to":"a"}), &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), ["gmail_send", "gmail_send"]);
    assert_eq!(calls.lock().unwrap().len(), 1);

    // Non-interactive runs never act.
    let mut ctx = context(
        Some(runtime(calls.clone())),
        Some((seen, ToolApprovalDecision::ApprovedOnce)),
    );
    ctx.execution_mode = ToolExecutionMode::NonInteractive;
    assert!(
        act.execute(json!({}), &ctx, CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn shared_requests_cannot_use_connector_tools() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut ctx = context(Some(runtime(calls.clone())), None);
    ctx.execution_policy = ExecutionPolicy::Shared;
    let tool = ConnectorTool::new(descriptor("gmail_search", ConnectorToolGroup::Read));
    assert!(
        tool.execute(json!({}), &ctx, CancellationToken::new())
            .await
            .is_err()
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn runtime_builds_one_tool_per_distinct_descriptor() {
    let mut runtime = runtime(Arc::new(Mutex::new(Vec::new())));
    runtime
        .descriptors
        .push(descriptor("gmail_search", ConnectorToolGroup::Act));
    let names = runtime
        .tools()
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, ["gmail_search", "gmail_send"]);
}

#[test]
fn connector_lease_parsing_drops_only_bad_entries() {
    let parsed = parse_lease_descriptors(json!([
        {"connectorId":"conn_1","provider":"gmail","name":"gmail_search","group":"read",
         "description":"Search mail."},
        {"connectorId":"conn_1","provider":"gmail","name":"gmail_watch","group":"stream",
         "description":"A group this build does not know."},
        "not an object",
        {"connectorId":"conn_1","provider":"gmail","name":"gmail_send","group":"act",
         "description":"Send mail.","inputSchema":{"type":"object"}}
    ]));
    let names = parsed.iter().map(|d| d.name.as_str()).collect::<Vec<_>>();
    assert_eq!(names, ["gmail_search", "gmail_send"]);
    assert!(parse_lease_descriptors(json!({"gmail_search": {}})).is_empty());
    assert!(parse_lease_descriptors(Value::Null).is_empty());
}
