//! Which document tools a run gets.
//!
//! `read_document` goes to every comment run and to chat runs in a session
//! that carries a document. `edit_document` goes to a comment run a person
//! started with their own agent, when that person can edit the document,
//! and to a chat run the agent's owner started in a session that carries a
//! document. On the owner's Mac the approval card asks before every edit;
//! on the cloud runner, as for comment runs, the server checks alone. Per
//! call the server checks that the named document is in the run's session
//! and that the owner can edit it. Never to another member's request, a
//! public reader's run, a background run, or a scheduled run. `create_document` goes to chat runs in a group, whoever
//! asked: the document is posted in that group as the agent's own message,
//! so it reaches exactly the people who already read the agent's reply
//! (issue 1808). The same gate is evaluated when the lease is delivered and
//! again on every call.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::access::{canonical_record, DocumentRecord};
use super::super::canonical::can_edit;
use super::super::model::Viewer;
use super::{comment_id_of_request, is_comment_request};
use crate::connectors::models::RunTrigger;

/// The facts the gate reads. All of them come from the run row and the
/// document, none from the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ToolGate {
    /// The run answers a document comment.
    pub comment_run: bool,
    pub trigger: RunTrigger,
    /// A scheduled task occurrence.
    pub scheduled: bool,
    /// The comment was written by a reader without an account.
    pub public_reader: bool,
    /// The requester may save the run's document.
    pub requester_can_edit: bool,
    /// A chat run whose session carries a Markdown or HTML document.
    pub session_has_document: bool,
    /// The run's session is a group conversation.
    pub group_session: bool,
    /// The agent's owner made the request.
    pub owner_request: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OfferedTools {
    pub read: bool,
    pub edit: bool,
    pub create: bool,
}

pub(crate) fn offered_tools(gate: &ToolGate) -> OfferedTools {
    OfferedTools {
        read: gate.comment_run || gate.session_has_document,
        edit: gate.trigger == RunTrigger::PersonStarted
            && !gate.scheduled
            && !gate.public_reader
            && if gate.comment_run {
                gate.requester_can_edit
            } else {
                gate.owner_request && gate.session_has_document
            },
        create: !gate.comment_run && gate.group_session && !gate.public_reader,
    }
}

/// A run as the document tools see it.
#[derive(Debug, Clone)]
pub(crate) struct RunFacts {
    pub owner_account_id: String,
    pub requester_account_id: String,
    pub agent_id: String,
    pub session_id: String,
    /// The canonical document of the comment a comment run answers.
    pub document: Option<DocumentRecord>,
    pub gate: ToolGate,
}

type RunRow = (String, String, String, String, String, String, bool);

/// Loads the run and evaluates its gate. `None` when the run does not exist or
/// is not a run that may use document tools at all (digest, System agent, and
/// background-session runs).
pub(crate) async fn run_facts(
    pool: &PgPool,
    run_id: &str,
) -> Result<Option<RunFacts>, sqlx_core::Error> {
    let row: Option<RunRow> = query_as(
        "SELECT owner_account_id, requester_account_id, execution_agent_id, session_id, \
                request_message_id, run_trigger, \
                subsession_id IS NOT NULL OR parent_run_id IS NOT NULL \
         FROM cloud_agent_fallback_runs WHERE run_id = $1 AND NOT legacy_duplicate",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner, requester, agent_id, session_id, request_id, trigger, child)) = row else {
        return Ok(None);
    };
    if child
        || run_id.starts_with(crate::digest::RUN_PREFIX)
        || crate::cloud_agent_runtime::import_runs::is_import_run(run_id)
        || run_id.starts_with(crate::system_agent::RUN_PREFIX)
        || run_id.starts_with(crate::common_ground::RUN_PREFIX)
        || run_id.starts_with(crate::proactive::RUN_PREFIX)
    {
        return Ok(None);
    }
    let comment_run = is_comment_request(&request_id);
    let mut gate = ToolGate {
        comment_run,
        trigger: RunTrigger::parse(&trigger),
        scheduled: request_id.trim().starts_with("scheduled_run_"),
        public_reader: false,
        requester_can_edit: false,
        session_has_document: false,
        group_session: false,
        owner_request: owner == requester,
    };
    let mut document = None;
    if comment_run {
        let comment: Option<(String, bool)> = match comment_id_of_request(&request_id) {
            Some(comment_id) => {
                query_as(
                    "SELECT attachment_id, author_reader_key IS NOT NULL \
                 FROM cloud_document_comments WHERE comment_id = $1",
                )
                .bind(comment_id)
                .fetch_optional(pool)
                .await?
            }
            None => None,
        };
        // A reader's run stays a reader's run even if its comment is gone.
        gate.public_reader = comment.as_ref().is_none_or(|(_, reader)| *reader);
        if let Some((attachment_id, _)) = comment {
            document = canonical_record(pool, &attachment_id)
                .await
                .map_err(|_| sqlx_core::Error::Protocol("document lookup failed".into()))?;
        }
        if let Some(record) = &document {
            let viewer = if record.owner_account_id == requester {
                Viewer::Owner
            } else {
                Viewer::Member
            };
            gate.requester_can_edit = can_edit(pool, record, viewer, &requester).await?;
        }
    } else {
        gate.session_has_document = !super::read::session_documents(pool, &session_id)
            .await?
            .is_empty();
        gate.group_session = super::create::is_group_session(pool, &session_id).await?;
    }
    Ok(Some(RunFacts {
        owner_account_id: owner,
        requester_account_id: requester,
        agent_id,
        session_id,
        document,
        gate,
    }))
}
