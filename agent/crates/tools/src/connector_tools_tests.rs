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
            descriptor("gmail.search", ConnectorToolGroup::Read),
            descriptor("gmail.send", ConnectorToolGroup::Act),
        ],
        call: Arc::new(move |descriptor, args| {
            calls
                .lock()
                .unwrap()
                .push(format!("{}:{args}", descriptor.name));
            Box::pin(async move { Ok(json!({"ok": true, "tool": descriptor.name})) })
        }),
        report_declined: None,
        offer_request_connect: false,
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
        "connectorId": "conn_1", "provider": "github", "name": "github.notifications",
        "group": "read", "description": "List notifications."
    }))
    .unwrap();
    assert_eq!(parsed.group, ConnectorToolGroup::Read);
    assert_eq!(parsed.input_schema, json!({"type":"object"}));
    let tool = ConnectorTool::new(parsed);
    assert_eq!(tool.name(), "github.notifications");
    assert_eq!(tool.metadata().risk, ToolRiskLevel::ReadOnly);
    assert!(!tool.allows_shared_requests());
}

#[tokio::test]
async fn connector_tool_fails_closed_without_a_runtime_or_descriptor() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let tool = ConnectorTool::new(descriptor("gmail.search", ConnectorToolGroup::Read));
    let error = tool
        .execute(json!({}), &context(None, None), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not available"));

    let missing = ConnectorTool::new(descriptor("gmail.delete", ConnectorToolGroup::Read));
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
    let tool = ConnectorTool::new(descriptor("gmail.search", ConnectorToolGroup::Read));
    let result = tool
        .execute(json!({"q":"invoices"}), &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result.details,
        Some(json!({"ok": true, "tool": "gmail.search"}))
    );
    assert_eq!(*calls.lock().unwrap(), [r#"gmail.search:{"q":"invoices"}"#]);
}

#[tokio::test]
async fn act_tools_always_ask_first_and_refuse_without_approval() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let act = ConnectorTool::new(descriptor("gmail.send", ConnectorToolGroup::Act));

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
    assert_eq!(*seen.lock().unwrap(), ["gmail.send", "gmail.send"]);
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
    let tool = ConnectorTool::new(descriptor("gmail.search", ConnectorToolGroup::Read));
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
        .push(descriptor("gmail.search", ConnectorToolGroup::Act));
    let names = runtime
        .tools()
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, ["gmail.search", "gmail.send"]);
}

#[tokio::test]
async fn declined_act_calls_are_reported_and_never_sent() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let reported = Arc::new(Mutex::new(Vec::new()));
    let mut runtime = runtime(calls.clone());
    let sink = reported.clone();
    runtime.report_declined = Some(Arc::new(move |descriptor| {
        sink.lock().unwrap().push(descriptor.name);
        Box::pin(async {})
    }));
    let act = ConnectorTool::new(descriptor("gmail.send", ConnectorToolGroup::Act));
    // No responder at all: refused before anyone was asked, nothing sent.
    let error = act
        .execute(
            json!({}),
            &context(Some(runtime.clone()), None),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("approval is not available"));
    // The person declined.
    let ctx = context(
        Some(runtime.clone()),
        Some((
            Arc::new(Mutex::new(Vec::new())),
            ToolApprovalDecision::Denied,
        )),
    );
    let error = act
        .execute(json!({}), &ctx, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("you declined"));
    assert_eq!(*reported.lock().unwrap(), ["gmail.send"]);
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn request_connect_is_offered_only_when_the_runtime_allows_it() {
    let mut runtime = runtime(Arc::new(Mutex::new(Vec::new())));
    let names = |runtime: &ConnectorToolsRuntime| {
        runtime
            .tools()
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>()
    };
    assert!(!names(&runtime).contains(&"connectors_request_connect".to_string()));
    runtime.offer_request_connect = true;
    assert_eq!(
        names(&runtime),
        ["gmail.search", "gmail.send", "connectors_request_connect"]
    );
}
