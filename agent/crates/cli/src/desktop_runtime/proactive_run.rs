//! Sessions of approved proactive runs. Such a run learns about its owner
//! only from Kordi memory, through the `search_memory` tool; Kordi already
//! imports the owner's `AGENTS.md` and `CLAUDE.md` there. So its prompt
//! loads no instruction file and preloads no memories, and its execution
//! context names no home folder, wherever its working folder is. Tools stay
//! as for any owner turn.

use std::path::PathBuf;

use anyhow::Result;

use super::{
    DesktopRuntimeSession, SessionBootstrapOptions, normalize_setup_thinking,
    prepare_session_runtime_for_cwd, retarget_runtime_setup_session, runtime_cwd_for_session,
};

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

    pub(super) async fn resume_chat(
        cwd: PathBuf,
        session_id: &str,
        proactive_run: bool,
    ) -> Result<Self> {
        let runtime_cwd = runtime_cwd_for_session(cwd, session_id)?;
        let options = chat_options(Some(session_id.to_string()), proactive_run);
        let (_runtime_host, _ui, mut setup) =
            prepare_session_runtime_for_cwd(runtime_cwd, options).await?;
        normalize_setup_thinking(&mut setup);
        Ok(Self::from_setup(setup, true))
    }
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
