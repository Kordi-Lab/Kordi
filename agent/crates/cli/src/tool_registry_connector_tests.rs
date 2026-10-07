use std::sync::{Arc, Mutex};

use kordi_tools::connector_tools::{
    ConnectorToolDescriptor, ConnectorToolGroup, ConnectorToolsRuntime,
};
use kordi_tools::{
    ToolApprovalDecision, ToolApprovalOutcome, ToolApprovalRequest, ToolContext, ToolRiskLevel,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;

fn descriptor(name: &str, group: ConnectorToolGroup) -> ConnectorToolDescriptor {
    ConnectorToolDescriptor {
        connector_id: "conn_1".into(),
        provider: "gmail".into(),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: json!({"type":"object"}),
    }
}

fn runtime() -> ConnectorToolsRuntime {
    ConnectorToolsRuntime {
        descriptors: vec![
            descriptor("gmail.search", ConnectorToolGroup::Read),
            descriptor("gmail.send", ConnectorToolGroup::Act),
        ],
        call: Arc::new(|descriptor, _| {
            Box::pin(async move { Ok(json!({ "tool": descriptor.name })) })
        }),
    }
}

fn connector_names(registry: &ToolRegistry) -> Vec<String> {
    registry
        .active_names()
        .iter()
        .filter(|name| name.contains('.'))
        .cloned()
        .collect()
}

#[test]
fn no_connector_tools_without_a_runtime() {
    let mut registry = ToolRegistry::from_builtin_and_extensions(vec![], ToolSelection::All);
    let before = registry.len();
    registry.set_connector_tools(None, true);
    assert_eq!(registry.len(), before);
    assert!(connector_names(&registry).is_empty());
    assert!(
        registry
            .tool_defs()
            .iter()
            .all(|def| !def["function"]["name"].as_str().unwrap().contains('.'))
    );
}

#[test]
fn lease_descriptors_register_and_are_replaced_each_turn() {
    let mut registry = ToolRegistry::from_builtin_and_extensions(vec![], ToolSelection::All);
    let before = registry.len();
    registry.set_connector_tools(Some(&runtime()), true);
    assert_eq!(connector_names(&registry), ["gmail.search", "gmail.send"]);
    assert_eq!(registry.len(), before + 2);
    assert_eq!(
        registry.metadata_for("gmail.send").unwrap().risk,
        ToolRiskLevel::High
    );
    assert!(
        registry
            .tool_defs()
            .iter()
            .any(|def| def["function"]["name"] == "gmail.search")
    );

    // The next turn without a lease drops them; disabled tools never appear.
    registry.set_connector_tools(None, true);
    assert_eq!(registry.len(), before);
    registry.set_connector_tools(Some(&runtime()), false);
    assert!(connector_names(&registry).is_empty());
}

#[test]
fn connector_tools_never_replace_existing_tools() {
    struct Existing;
    #[async_trait::async_trait]
    impl Tool for Existing {
        fn name(&self) -> &str {
            "gmail.search"
        }
        fn description(&self) -> &str {
            "existing"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            json!({"type":"object"})
        }
        async fn execute(
            &self,
            _: serde_json::Value,
            _: &ToolContext,
            _: CancellationToken,
        ) -> kordi_core::error::KordiResult<kordi_tools::ToolResult> {
            unimplemented!()
        }
    }
    let mut registry = ToolRegistry::from_tools(vec![Box::new(Existing)]);
    registry.set_connector_tools(Some(&runtime()), true);
    assert_eq!(registry.active_names(), ["gmail.search", "gmail.send"]);
    assert_eq!(registry.active_tools()[0].description(), "existing");
    // Removing connector tools keeps the existing tool.
    registry.set_connector_tools(None, true);
    assert_eq!(registry.active_names(), ["gmail.search"]);
}

#[tokio::test]
async fn act_tools_registered_from_a_lease_invoke_the_approval_hook() {
    let mut registry = ToolRegistry::from_tools(vec![]);
    let runtime = runtime();
    registry.set_connector_tools(Some(&runtime), true);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let ctx = ToolContext {
        connector_tools: Some(runtime),
        request_approval: Some(Arc::new(move |request: ToolApprovalRequest| {
            seen.lock().unwrap().push(request.tool_name);
            Box::pin(async {
                ToolApprovalOutcome {
                    decision: ToolApprovalDecision::ApprovedOnce,
                }
            })
        })),
        ..Default::default()
    };
    for tool in registry.active_tools() {
        tool.execute(json!({}), &ctx, CancellationToken::new())
            .await
            .unwrap();
    }
    assert_eq!(*asked.lock().unwrap(), ["gmail.send"], "only act tools ask");
}
