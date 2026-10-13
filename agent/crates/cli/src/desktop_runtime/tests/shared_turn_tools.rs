fn lease_tool(
    provider: &str,
    name: &str,
    group: kordi_tools::connector_tools::ConnectorToolGroup,
) -> kordi_tools::connector_tools::ConnectorToolDescriptor {
    kordi_tools::connector_tools::ConnectorToolDescriptor {
        connector_id: format!("conn_{provider}"),
        provider: provider.into(),
        name: name.into(),
        group,
        description: format!("{name} description"),
        input_schema: serde_json::json!({ "type": "object" }),
    }
}

#[test]
fn a_shared_turn_keeps_only_the_read_only_document_tool_of_its_lease() {
    use kordi_tools::connector_tools::{ConnectorToolGroup, ConnectorToolsRuntime};
    let lease = ConnectorToolsRuntime {
        descriptors: vec![
            lease_tool("gmail", "gmail_search", ConnectorToolGroup::Read),
            lease_tool("gmail", "gmail_send", ConnectorToolGroup::Act),
            lease_tool("kordi_documents", "read_document", ConnectorToolGroup::Read),
            lease_tool("kordi_documents", "edit_document", ConnectorToolGroup::Act),
        ],
        call: std::sync::Arc::new(|_, _| Box::pin(async { Ok(serde_json::json!({})) })),
        report_declined: None,
        offer_request_connect: true,
    };
    let names = |runtime: Option<ConnectorToolsRuntime>| {
        runtime.map(|runtime| {
            runtime
                .tools()
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>()
        })
    };

    // The owner's own request keeps the whole lease.
    let owner = turn_execution::turn_connector_tools(Some(&lease), true);
    assert_eq!(names(owner).map(|names| names.len()), Some(5));

    // Anyone else's request reads the shared document and nothing more.
    let shared = turn_execution::turn_connector_tools(Some(&lease), false);
    assert_eq!(names(shared), Some(vec!["read_document".to_string()]));

    // No document tool on the lease, or no lease: nothing.
    let mut connectors_only = lease.clone();
    connectors_only.descriptors.truncate(2);
    assert!(turn_execution::turn_connector_tools(Some(&connectors_only), false).is_none());
    assert!(turn_execution::turn_connector_tools(None, false).is_none());
    assert!(turn_execution::turn_connector_tools(None, true).is_none());
}
