//! Documents a background task writes for its parent group (issue 1808).
//!
//! A background task holds no execution lease of its own. It gets the
//! parent turn's `create_document`, and only that tool, through the parent
//! lease's run and claim ids, so a document it writes is saved in the parent
//! group's Artifacts instead of a local file. The server still gates every
//! call and accepts the parent's claim for a while after the parent answered.

use kordi_cli::desktop_runtime::{DesktopChatContextMessage, DesktopCloudExecutionLease};

/// Added to the turn's prompt only when the turn can call `create_document`
/// (issue 1808): a prompt never asks for a tool the model does not have.
pub(in crate::chat) const GROUP_DOCUMENTS_POLICY: &str = "When someone asks for a document, note, report, or plan for this conversation, create it with create_document (Markdown, or HTML for a page) so it is attached to your reply and saved in this conversation's Artifacts for every member; do not write it to a local file or folder instead. Write the complete document first, then call create_document once per document, at the end, with a specific title (never Untitled) and the finished content. Other formats, such as .docx, are only for an explicit request and are not shared documents. If background work should produce such a document, say in the spawn message that the child must create it with create_document.";

/// Id of the resource message that carries the group directory and the
/// document lease into a background turn.
const GROUP_DIRECTORY_ID: &str = "group-directory";

/// The parent lease reduced to `create_document`; `None` when the parent
/// lease does not carry it.
pub(in crate::chat) fn group_document_lease(
    lease: Option<&DesktopCloudExecutionLease>,
) -> Option<DesktopCloudExecutionLease> {
    let lease = lease?;
    let tools = lease
        .connector_tools
        .as_ref()?
        .iter()
        .filter(|tool| tool.is_group_document_create())
        .cloned()
        .collect::<Vec<_>>();
    (!tools.is_empty()).then(|| DesktopCloudExecutionLease {
        connector_tools: Some(tools),
        connector_audience: None,
        ..lease.clone()
    })
}

/// The resource message of a background turn: the group directory, and the
/// document lease when the parent had one.
pub(super) fn resource_message(
    directory: Option<&String>,
    document_lease: Option<&DesktopCloudExecutionLease>,
) -> Option<DesktopChatContextMessage> {
    if directory.is_none() && document_lease.is_none() {
        return None;
    }
    Some(DesktopChatContextMessage {
        execution_lease: document_lease.cloned(),
        id: GROUP_DIRECTORY_ID.to_string(),
        author_name: "Group directory".to_string(),
        author_kind: "agent".to_string(),
        context_role: Some("resource".to_string()),
        text: directory.cloned().unwrap_or_default(),
        created_at_ms: None,
    })
}

/// The document lease a background turn received in its resource message.
pub(in crate::chat) fn resource_document_lease(
    messages: &[DesktopChatContextMessage],
) -> Option<DesktopCloudExecutionLease> {
    messages
        .iter()
        .filter(|message| message.context_role.as_deref() == Some("resource"))
        .find_map(|message| message.execution_lease.clone())
        .filter(|lease| {
            lease
                .connector_tools
                .as_ref()
                .is_some_and(|tools| tools.iter().all(|tool| tool.is_group_document_create()))
        })
}

#[cfg(test)]
mod tests {
    use kordi_tools::connector_tools::{
        ConnectorToolDescriptor, ConnectorToolGroup, CREATE_DOCUMENT_TOOL, DOCUMENT_TOOLS_PROVIDER,
    };

    use super::*;

    fn tool(provider: &str, name: &str, group: ConnectorToolGroup) -> ConnectorToolDescriptor {
        ConnectorToolDescriptor {
            connector_id: format!("conn_{provider}"),
            provider: provider.into(),
            name: name.into(),
            group,
            description: String::new(),
            input_schema: serde_json::json!({ "type": "object" }),
        }
    }

    fn lease(tools: Vec<ConnectorToolDescriptor>) -> DesktopCloudExecutionLease {
        DesktopCloudExecutionLease {
            session_id: "session:group:g1".into(),
            run_id: "run_parent".into(),
            claim_id: "claim_parent".into(),
            owner_account_id: "acct_owner".into(),
            connector_tools: Some(tools),
            connector_audience: Some("owner_private".into()),
        }
    }

    #[test]
    fn a_background_task_gets_only_the_parents_create_document() {
        let parent = lease(vec![
            tool("gmail", "gmail_send", ConnectorToolGroup::Act),
            tool(
                DOCUMENT_TOOLS_PROVIDER,
                "read_document",
                ConnectorToolGroup::Read,
            ),
            tool(
                DOCUMENT_TOOLS_PROVIDER,
                CREATE_DOCUMENT_TOOL,
                ConnectorToolGroup::Act,
            ),
        ]);
        let child = group_document_lease(Some(&parent)).expect("create_document stays");
        let names: Vec<&str> = child
            .connector_tools
            .as_ref()
            .unwrap()
            .iter()
            .map(|tool| tool.name.as_str())
            .collect();
        assert_eq!(names, [CREATE_DOCUMENT_TOOL]);
        assert_eq!(
            (child.run_id.as_str(), child.claim_id.as_str()),
            ("run_parent", "claim_parent")
        );
        assert_eq!(child.connector_audience, None);

        let message = resource_message(None, Some(&child)).unwrap();
        assert_eq!(message.text, "");
        assert_eq!(resource_document_lease(&[message]), Some(child));

        // No create tool on the parent lease, or no lease: nothing to pass on.
        let reader = lease(vec![tool(
            DOCUMENT_TOOLS_PROVIDER,
            "read_document",
            ConnectorToolGroup::Read,
        )]);
        assert!(group_document_lease(Some(&reader)).is_none());
        assert!(group_document_lease(None).is_none());
        assert!(resource_message(None, None).is_none());
    }

    #[test]
    fn document_guidance_asks_for_one_finished_call() {
        let documents = super::GROUP_DOCUMENTS_POLICY;
        assert!(documents.contains("create it with create_document"));
        assert!(documents.contains("the child must create it with create_document"));
        assert!(documents.contains("call create_document once per document, at the end"));
        assert!(documents.contains("never Untitled"));
    }

    #[test]
    fn a_resource_lease_with_any_other_tool_is_ignored() {
        let mut message = resource_message(Some(&"Members".to_string()), None).unwrap();
        assert_eq!(message.text, "Members");
        assert!(resource_document_lease(std::slice::from_ref(&message)).is_none());
        message.execution_lease = Some(lease(vec![tool(
            "gmail",
            "gmail_send",
            ConnectorToolGroup::Act,
        )]));
        assert!(resource_document_lease(&[message]).is_none());
    }
}
