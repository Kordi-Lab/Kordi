//! Sessions of approved proactive runs. Such a run learns about its owner
//! only from Kordi memory, through the `search_memory` tool; Kordi already
//! imports the owner's `AGENTS.md` and `CLAUDE.md` there. So its prompt
//! loads no instruction file and preloads no memories, and its execution
//! context names no home folder, wherever its working folder is. Tools stay
//! as for any owner turn, except that the run starts no background
//! subsessions: its answer is the turn's own reply, posted once the turn
//! ends, and its folder goes with the turn.
//!
//! The stored session carries a marker entry, so a session of such a run
//! stays one however it is resumed: by the run itself, by a later message, or
//! when the owner opens it.

use std::path::PathBuf;

use anyhow::Result;
use kordi_core::types::{EntryBase, EntryId, SessionEntry};

use super::{
    DesktopRuntimeSession, SessionBootstrapOptions, SessionRuntimeSetup, normalize_setup_thinking,
    open_sessions_db, prepare_session_runtime_for_cwd, retarget_runtime_setup_session,
    runtime_cwd_for_session,
};

/// The custom entry that marks a stored session of an approved proactive
/// run. Local-only metadata, like a subsession's saved runtime profile.
const SESSION_MARKER: &str = "proactive_run_session";

impl DesktopRuntimeSession {
    /// A new session for an approved proactive run's turn.
    pub async fn create_proactive_run(cwd: PathBuf, session_id: &str) -> Result<Self> {
        Self::create_chat(cwd, session_id, true).await
    }

    /// The session an earlier attempt of an approved proactive run stored.
    pub async fn resume_proactive_run(cwd: PathBuf, session_id: &str) -> Result<Self> {
        Self::resume_chat(cwd, session_id, true).await
    }

    /// True for the session of an approved proactive run or its subsession.
    pub fn is_proactive_run(&self) -> bool {
        self.setup.proactive_run
    }

    pub(super) async fn create_chat(
        cwd: PathBuf,
        session_id: &str,
        proactive_run: bool,
    ) -> Result<Self> {
        let options = chat_options(None, proactive_run);
        let (_runtime_host, _ui, mut setup) = prepare_session_runtime_for_cwd(cwd, options).await?;
        retarget_runtime_setup_session(&mut setup, session_id)?;
        normalize_setup_thinking(&mut setup);
        Ok(Self::from_setup(setup, true))
    }

    /// Resumes a stored chat session; one marked as an approved proactive
    /// run's resumes as one even when `proactive_run` is false.
    pub(super) async fn resume_chat(
        cwd: PathBuf,
        session_id: &str,
        proactive_run: bool,
    ) -> Result<Self> {
        let proactive_run = proactive_run || is_marked(&open_sessions_db()?, session_id)?;
        let runtime_cwd = runtime_cwd_for_session(cwd, session_id)?;
        let options = chat_options(Some(session_id.to_string()), proactive_run);
        let (_runtime_host, _ui, mut setup) =
            prepare_session_runtime_for_cwd(runtime_cwd, options).await?;
        normalize_setup_thinking(&mut setup);
        // A session an earlier build stored without the marker gets it now.
        mark(&setup)?;
        Ok(Self::from_setup(setup, true))
    }
}

/// Creates the session's stored row, marked when the session belongs to an
/// approved proactive run.
pub(super) fn create_session_row(setup: &SessionRuntimeSetup) -> Result<()> {
    let cwd = setup.tool_ctx.cwd.display().to_string();
    kordi_session::store::create_session_with_id(&setup.conn, &setup.session_id, &cwd)?;
    mark(setup)
}

fn is_marked(conn: &rusqlite::Connection, session_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')=?2)",
        [session_id, SESSION_MARKER],
        |row| row.get(0),
    )?)
}

/// Marks the stored session of an approved proactive run once. Nothing to
/// do for any other session or before the session is stored.
fn mark(setup: &SessionRuntimeSetup) -> Result<()> {
    if !setup.proactive_run || is_marked(&setup.conn, &setup.session_id)? {
        return Ok(());
    }
    let Some(row) = kordi_session::store::get_session(&setup.conn, &setup.session_id)? else {
        return Ok(());
    };
    let entry = SessionEntry::Custom {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: row.leaf_id.map(EntryId),
            timestamp: chrono::Utc::now(),
        },
        custom_type: SESSION_MARKER.into(),
        data: Some(serde_json::json!({"proactiveRun": true})),
    };
    kordi_session::store::append_entry(&setup.conn, &setup.session_id, &entry)?;
    Ok(())
}

/// The bootstrap options of an owner's chat session.
pub(super) fn chat_options(
    session: Option<String>,
    proactive_run: bool,
) -> SessionBootstrapOptions {
    SessionBootstrapOptions {
        session,
        proactive_run,
        ..SessionBootstrapOptions::default()
    }
}
