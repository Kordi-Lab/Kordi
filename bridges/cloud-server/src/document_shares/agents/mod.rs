//! Agents in shared documents (issue 1741).
//!
//! An agent reads a document through `read_document`, answers when a comment
//! mentions it, and edits the document through `edit_document` when the
//! person who owns it asked. Every rule here is checked by the server, on
//! the run row and the document, never by prompt wording:
//!
//! - [`mentions`] decides which agent a comment names.
//! - [`runs`] charges the requester and queues one run per comment and agent.
//! - [`prompt`] builds the run's prompt from the thread and nearby blocks.
//! - [`delivery`] turns the run's answer into a reply comment, never a chat
//!   message.
//! - [`tools`] puts the two tools on the run's lease next to connector tools
//!   and executes them under the lease; [`operations`] applies block edits.
//!
//! Contract: `docs/development/issue-1741-shared-documents.md`, section
//! "Agents in documents".

pub(crate) mod annotate;
pub(crate) mod delivery;
mod edit;
pub(crate) mod gating;
pub(crate) mod mentions;
pub(crate) mod operations;
pub(crate) mod prompt;
mod read;
pub(crate) mod runs;
pub(crate) mod threads;
pub(crate) mod tools;

#[cfg(test)]
mod tests;

pub(crate) use delivery::{complete_comment_run, fail_comment_run};

/// `request_message_id` prefix of a run started by a document comment.
pub(crate) const COMMENT_REQUEST_PREFIX: &str = "doccmt:";

/// The `connectorId` and `provider` the document tools carry on a lease.
/// The broker route hands calls with this id to [`tools::call`].
pub(crate) const DOCUMENT_CONNECTOR_ID: &str = "kordi-documents";
pub(crate) const DOCUMENT_PROVIDER: &str = "kordi_documents";

pub(crate) const READ_DOCUMENT_TOOL: &str = "read_document";
pub(crate) const EDIT_DOCUMENT_TOOL: &str = "edit_document";

/// Largest text `read_document` returns and `edit_document` accepts.
pub(crate) const MAX_TOOL_TEXT_BYTES: usize = 200_000;
/// Most operations one `edit_document` call may carry.
pub(crate) const MAX_EDIT_OPERATIONS: usize = 20;

/// `request_message_id` of the run a comment starts.
pub(crate) fn comment_request_id(comment_id: &str) -> String {
    format!("{COMMENT_REQUEST_PREFIX}{comment_id}")
}

/// Whether a run answers a document comment. Such a run never produces a
/// chat message.
pub(crate) fn is_comment_request(request_message_id: &str) -> bool {
    request_message_id
        .trim()
        .starts_with(COMMENT_REQUEST_PREFIX)
}

/// The comment a comment run answers.
pub(crate) fn comment_id_of_request(request_message_id: &str) -> Option<&str> {
    request_message_id
        .trim()
        .strip_prefix(COMMENT_REQUEST_PREFIX)
        .filter(|id| !id.is_empty())
}

/// The agent's display name: its definition's name, else the owner's default
/// agent profile, else "Kordi".
pub(crate) const AGENT_NAME_SQL: &str = "COALESCE( \
       (SELECT definition.name FROM cloud_agent_definitions definition \
         WHERE definition.agent_id = run.execution_agent_id \
           AND definition.owner_account_id = run.owner_account_id), \
       (SELECT profile.display_name FROM cloud_default_agent_profiles profile \
         WHERE profile.owner_account_id = run.owner_account_id), \
       'Kordi')";
