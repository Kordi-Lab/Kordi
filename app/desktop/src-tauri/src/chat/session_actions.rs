use super::{is_blank_draft_summary, session_exists_globally, TRANSIENT_LOCAL_DRAFT_SESSION_ID};

pub(super) struct SessionActionTarget {
    pub(super) id: String,
    pub(super) local_exists: bool,
    pub(super) canonical_exists: bool,
}

pub(super) fn resolve_existing_session_action_target(
    session_id: &str,
) -> Result<SessionActionTarget, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return Err("Session not found".to_string());
    }

    let local_exists = session_exists_globally(session_id)?;
    let canonical_exists = crate::canonical_sessions::session_exists(session_id)?;
    if !local_exists && !canonical_exists {
        return Err(format!("Session not found: {session_id}"));
    }

    Ok(SessionActionTarget {
        id: session_id.to_string(),
        local_exists,
        canonical_exists,
    })
}

pub(super) fn resolve_session_action_fallback_target(
    cwd: &std::path::Path,
    preferred_active_session_id: Option<String>,
) -> Result<String, String> {
    if let Some(session_id) = preferred_active_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session_exists_globally(session_id)? {
            return Ok(session_id.to_string());
        }
    }

    let next_chat_session_id = kordi_cli::desktop_runtime::list_session_summaries(cwd)
        .map_err(|err| err.to_string())?
        .into_iter()
        .find(|session| !is_blank_draft_summary(session))
        .map(|session| session.id);

    Ok(next_chat_session_id.unwrap_or_else(|| TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string()))
}

pub(crate) fn expand_home_project_path(raw_path: &str) -> std::path::PathBuf {
    if raw_path == "~" {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(raw_path));
    }
    if let Some(rest) = raw_path.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(|home| home.join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(raw_path));
    }
    std::path::PathBuf::from(raw_path)
}

pub(super) fn resolve_project_root_input(
    cwd: &std::path::Path,
    raw_project_root: &str,
) -> Result<std::path::PathBuf, String> {
    let trimmed = raw_project_root.trim();
    if trimmed.is_empty() {
        return Err("Project folder is required".to_string());
    }

    let candidate = expand_home_project_path(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    std::fs::create_dir_all(&resolved).map_err(|err| err.to_string())?;
    Ok(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_home_project_path_uses_home_for_tilde_prefix() {
        let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
            return;
        };
        assert_eq!(expand_home_project_path("~/Project"), home.join("Project"),);
    }
}
