//! Typed session catalog, detail, lineage, and fork projections.

use anyhow::Context;
use kordi_protocol::{
    ForkSessionRequest, ForkSessionResponse, SessionDetail, SessionForksPage, SessionSource,
    SessionStatus, SessionSummary, SessionsPage,
};
use kordi_session::store;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

use crate::protocol_mapping::{entry_preview, timeline_entry_from_row};

#[derive(Debug)]
pub(super) enum SessionProjectionError {
    BadRequest(String),
    NotFound(String),
    Internal(anyhow::Error),
}

impl fmt::Display for SessionProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadRequest(message) | Self::NotFound(message) => formatter.write_str(message),
            Self::Internal(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for SessionProjectionError {}

impl From<anyhow::Error> for SessionProjectionError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

type ProjectionResult<T> = std::result::Result<T, SessionProjectionError>;

pub(super) fn load_sessions_page(
    sessions_db_path: &Path,
    cwd: &Path,
    limit: usize,
    active_turns: &HashSet<String>,
) -> ProjectionResult<SessionsPage> {
    let conn = store::open_db(sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            sessions_db_path.display()
        )
    })?;
    let cwd = cwd.display().to_string();
    let rows =
        store::list_sessions(&conn, &cwd).with_context(|| format!("listing sessions for {cwd}"))?;

    let fork_counts = fork_counts_by_parent(&rows);
    let items = rows
        .iter()
        .take(limit)
        .map(|row| session_summary_from_row(&conn, row, active_turns, &fork_counts))
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(SessionsPage {
        items,
        next_cursor: None,
    })
}

pub(super) fn load_session_detail(
    sessions_db_path: &Path,
    cwd: &Path,
    session_id: &str,
    active_turns: &HashSet<String>,
) -> ProjectionResult<SessionDetail> {
    let conn = open_session_store(sessions_db_path)?;
    let cwd = cwd.display().to_string();
    let Some(row) = store::get_session(&conn, session_id)? else {
        return Err(SessionProjectionError::NotFound(format!(
            "session {session_id} was not found for workspace {cwd}"
        )));
    };
    if row.cwd != cwd {
        return Err(SessionProjectionError::NotFound(format!(
            "session {session_id} does not belong to workspace {cwd}"
        )));
    }
    let rows = store::list_sessions(&conn, &cwd)?;
    let fork_counts = fork_counts_by_parent(&rows);
    let session = session_summary_from_row(&conn, &row, active_turns, &fork_counts)?;
    let entries = store::get_entries(&conn, session_id)?
        .iter()
        .map(timeline_entry_from_row)
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(SessionDetail {
        session,
        entries,
        has_more: false,
        next_cursor: None,
    })
}

pub(super) fn load_session_forks(
    sessions_db_path: &Path,
    cwd: &Path,
    session_id: &str,
    active_turns: &HashSet<String>,
) -> ProjectionResult<SessionForksPage> {
    let conn = open_session_store(sessions_db_path)?;
    let cwd = cwd.display().to_string();
    let rows = store::list_sessions(&conn, &cwd)?;
    if !rows.iter().any(|row| row.session_id == session_id) {
        return Err(SessionProjectionError::NotFound(format!(
            "session {session_id} was not found for workspace {cwd}"
        )));
    }
    let fork_counts = fork_counts_by_parent(&rows);
    let items = rows
        .iter()
        .filter(|row| row.parent_session_id.as_deref() == Some(session_id))
        .map(|row| session_summary_from_row(&conn, row, active_turns, &fork_counts))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(SessionForksPage {
        items,
        next_cursor: None,
    })
}

pub(super) fn fork_session(
    sessions_db_path: &Path,
    cwd: &Path,
    source_session_id: &str,
    request: ForkSessionRequest,
) -> ProjectionResult<ForkSessionResponse> {
    let source_entry_id = request.source_entry_id.trim();
    if source_entry_id.is_empty() {
        return Err(SessionProjectionError::BadRequest(
            "source_entry_id must not be empty".to_string(),
        ));
    }
    let conn = open_session_store(sessions_db_path)?;
    let cwd = cwd.display().to_string();
    let Some(source_session) = store::get_session(&conn, source_session_id)? else {
        return Err(SessionProjectionError::NotFound(format!(
            "session {source_session_id} was not found for workspace {cwd}"
        )));
    };
    if source_session.cwd != cwd {
        return Err(SessionProjectionError::NotFound(format!(
            "session {source_session_id} does not belong to workspace {cwd}"
        )));
    }
    let forked = store::fork_session_from_entry(&conn, source_session_id, source_entry_id, &cwd)
        .map_err(classify_fork_error)?;
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store::set_session_name(&conn, &forked.session_id, Some(title))?;
    }
    let rows = store::list_sessions(&conn, &cwd)?;
    let fork_counts = fork_counts_by_parent(&rows);
    let fork_row = rows
        .iter()
        .find(|row| row.session_id == forked.session_id)
        .ok_or_else(|| {
            SessionProjectionError::Internal(anyhow::anyhow!(
                "fork session {} was not found after creation",
                forked.session_id
            ))
        })?;
    let session = session_summary_from_row(&conn, fork_row, &HashSet::new(), &fork_counts)?;
    Ok(ForkSessionResponse {
        session,
        source_session_id: forked.source_session_id,
        source_entry_id: forked.source_entry_id,
    })
}

fn open_session_store(sessions_db_path: &Path) -> anyhow::Result<rusqlite::Connection> {
    store::open_db(sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            sessions_db_path.display()
        )
    })
}

fn classify_fork_error(error: anyhow::Error) -> SessionProjectionError {
    let message = error.to_string();
    let normalized = message.to_lowercase();
    if normalized.contains("invalid entry id")
        || normalized.contains("entry not found")
        || normalized.contains("was not found")
    {
        SessionProjectionError::NotFound(message)
    } else {
        SessionProjectionError::Internal(error)
    }
}

fn fork_counts_by_parent(rows: &[store::SessionRow]) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for row in rows {
        if let Some(parent_id) = row
            .parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            *counts.entry(parent_id.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: &store::SessionRow,
    active_turns: &HashSet<String>,
    fork_counts: &HashMap<String, u32>,
) -> anyhow::Result<SessionSummary> {
    let status = if active_turns.contains(&row.session_id) {
        SessionStatus::Running
    } else {
        SessionStatus::Idle
    };
    let preview = session_preview(conn, &row.session_id, row.leaf_id.as_deref())?;
    let title = row
        .name
        .clone()
        .filter(|name| {
            !kordi_session::naming::is_raw_session_identifier(name, &row.session_id)
                && !kordi_session::naming::is_explicit_placeholder_session_title(name)
                && row.title_source != store::SessionTitleSource::Placeholder
                && (!matches!(
                    row.title_source,
                    store::SessionTitleSource::Auto | store::SessionTitleSource::Legacy
                ) || !kordi_session::naming::is_placeholder_or_weak_legacy_title(
                    name,
                    &row.session_id,
                ))
        })
        .or_else(|| {
            preview
                .as_deref()
                .and_then(kordi_session::naming::derive_session_title)
        })
        .unwrap_or_else(|| fallback_session_title(row));

    Ok(SessionSummary {
        session_id: row.session_id.clone(),
        title,
        source: SessionSource::Local,
        status,
        updated_at: row.updated_at.clone(),
        cwd: Some(row.cwd.clone()),
        project_id: None,
        peer_id: None,
        parent_session_id: row.parent_session_id.clone(),
        parent_session_message_id: row.parent_session_message_id.clone(),
        fork_count: fork_counts.get(&row.session_id).copied().unwrap_or(0),
        last_message_preview: preview,
        unread_count: 0,
    })
}

fn session_preview(
    conn: &rusqlite::Connection,
    session_id: &str,
    leaf_id: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let Some(leaf_id) = leaf_id else {
        return Ok(None);
    };
    let Some(entry) = store::get_entry(conn, session_id, leaf_id)? else {
        return Ok(None);
    };
    let parsed = store::parse_entry(&entry)?;
    Ok(entry_preview(&parsed))
}

fn fallback_session_title(row: &store::SessionRow) -> String {
    if row.entry_count <= 0 {
        return "New chat".to_string();
    }
    let date = chrono::DateTime::parse_from_rfc3339(&row.created_at)
        .map(|value| value.format("%b %-d").to_string())
        .unwrap_or_else(|_| "recently".to_string());
    format!("Chat with My Kordi · {date}")
}
