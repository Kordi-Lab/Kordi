use anyhow::Result;
use chrono::{Local, TimeZone};
use kordi_core::settings::Settings;

use super::attachments::attachment_summary_from_metadata;
use super::transcript::load_session_messages;
use super::{
    DesktopChatMessage, DesktopChatProjectGroup, DesktopChatProjectInfo, DesktopChatProjectSource,
    DesktopChatSessionSummary,
};

fn parse_db_timestamp_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|dt| Local.from_local_datetime(&dt).single())
                .map(|dt| dt.timestamp_millis())
        })
}

fn session_last_message_timestamp(conn: &rusqlite::Connection, session_id: &str) -> Option<String> {
    kordi_session::store::get_last_message_timestamp(conn, session_id)
        .ok()
        .flatten()
}

fn session_last_activity_timestamp(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> String {
    session_last_message_timestamp(conn, &row.session_id)
        .or_else(|| {
            kordi_session::store::get_last_entry_timestamp(conn, &row.session_id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| row.created_at.clone())
}

fn session_sort_timestamp_ms(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> i64 {
    parse_db_timestamp_millis(&session_last_activity_timestamp(conn, row)).unwrap_or_default()
}

pub(super) fn session_activity_label(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> String {
    format_db_timestamp(&session_last_activity_timestamp(conn, row))
}

fn is_placeholder_session_name(row: &kordi_session::store::SessionRow) -> bool {
    row.name.as_deref().is_some_and(|value| {
        let trimmed = value.trim();
        trimmed.eq_ignore_ascii_case("New session")
            || trimmed
                .eq_ignore_ascii_case(&format!("Session {}", short_session_id(&row.session_id)))
    })
}

pub(super) fn session_row_display_name(row: &kordi_session::store::SessionRow) -> Option<String> {
    if is_placeholder_session_name(row) {
        return None;
    }
    row.name.clone().filter(|value| !value.trim().is_empty())
}

pub(super) fn session_title_from_seed(value: &str) -> Option<String> {
    let title = value
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then(|| truncate_chars(&title, 60))
}

pub(super) fn session_title_from_messages(messages: &[DesktopChatMessage]) -> Option<String> {
    messages
        .iter()
        .find(|message| message.role == "user")
        .and_then(|message| {
            session_title_from_seed(&message.text).or_else(|| {
                attachment_summary_from_metadata(&message.attachments)
                    .and_then(|value| session_title_from_seed(&value))
            })
        })
}

pub(super) fn repair_session_title_from_history(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> Result<Option<String>> {
    if let Some(title) = session_row_display_name(row) {
        return Ok(Some(title));
    }
    if row.entry_count <= 0 {
        return Ok(None);
    }

    // Forked sessions inherit history from their source; deriving the
    // title from the inherited messages would just duplicate the
    // parent's name. Pick the first user message added AFTER the fork
    // anchor instead so each fork is named after what made it distinct.
    if row.parent_session_message_id.is_some() {
        if let Some(title) = first_post_fork_user_title(conn, row)? {
            kordi_session::store::set_session_name(conn, &row.session_id, Some(&title))?;
            return Ok(Some(title));
        }
        // Don't persist a placeholder so the title auto-upgrades the
        // moment the user sends their first message in this fork.
        return Ok(Some("New fork".to_string()));
    }

    let Some(title) = session_title_from_messages(&load_session_messages(conn, &row.session_id)?)
    else {
        return Ok(None);
    };
    kordi_session::store::set_session_name(conn, &row.session_id, Some(&title))?;
    Ok(Some(title))
}

fn first_post_fork_user_title(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> Result<Option<String>> {
    let Some(anchor) = row.parent_session_message_id.as_deref() else {
        return Ok(None);
    };
    let entries = kordi_session::store::get_entries(conn, &row.session_id)?;
    let Some(anchor_seq) = entries
        .iter()
        .find(|entry| entry.entry_id == anchor)
        .map(|entry| entry.seq)
    else {
        return Ok(None);
    };
    for entry_row in entries
        .iter()
        .filter(|entry| entry.seq > anchor_seq && entry.entry_type == "message")
    {
        let entry = kordi_session::store::parse_entry(entry_row)?;
        let kordi_core::types::SessionEntry::Message {
            message: kordi_core::types::AgentMessage::User(user),
            ..
        } = entry
        else {
            continue;
        };
        let text = user
            .content
            .iter()
            .filter_map(|block| match block {
                kordi_core::types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(title) = session_title_from_seed(&text) {
            return Ok(Some(title));
        }
    }
    Ok(None)
}

fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: kordi_session::store::SessionRow,
) -> Result<DesktopChatSessionSummary> {
    let updated_at_label = session_activity_label(conn, &row);
    let title =
        repair_session_title_from_history(conn, &row)?.unwrap_or_else(|| "New session".to_string());
    let subtitle = match kordi_session::context::build_context(conn, &row.session_id) {
        Ok(context) => context
            .model
            .map(|model| format!("{}/{}", model.provider, model.model_id))
            .unwrap_or_else(|| format!("{} entries", row.entry_count)),
        Err(_) => format!("{} entries", row.entry_count),
    };

    Ok(DesktopChatSessionSummary {
        id: row.session_id,
        title,
        subtitle,
        updated_at_label,
        message_count: row.entry_count.max(0) as usize,
        draft: false,
        forked_from_session_id: row.parent_session_id,
        forked_from_message_id: row.parent_session_message_id,
    })
}

pub(super) fn open_sessions_db() -> Result<rusqlite::Connection> {
    let global_settings = Settings::load_global();
    kordi_session::store::open_db(&kordi_core::config::session_db_path(
        &global_settings.storage,
    ))
}

pub(super) fn runtime_cwd_for_session(
    fallback_cwd: std::path::PathBuf,
    session_id: &str,
) -> Result<std::path::PathBuf> {
    let conn = open_sessions_db()?;
    let Some(row) = kordi_session::store::get_session(&conn, session_id)? else {
        return Ok(fallback_cwd);
    };

    if row.session_scope == "project" {
        if let Some(project_root) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(std::path::PathBuf::from(project_root));
        }
    }

    let row_cwd = row.cwd.trim();
    if row_cwd.is_empty() {
        Ok(fallback_cwd)
    } else {
        Ok(std::path::PathBuf::from(row_cwd))
    }
}

pub fn list_session_summaries(cwd: &std::path::Path) -> Result<Vec<DesktopChatSessionSummary>> {
    let conn = open_sessions_db()?;
    let cwd_str = cwd.display().to_string();
    let mut rows = kordi_session::store::list_sessions(&conn, &cwd_str)?;
    rows.sort_by(|left, right| {
        session_sort_timestamp_ms(&conn, right)
            .cmp(&session_sort_timestamp_ms(&conn, left))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });

    rows.into_iter()
        .map(|row| session_summary_from_row(&conn, row))
        .collect()
}

pub(super) fn project_group_id(project_root: &std::path::Path) -> String {
    format!("project:{}", project_root.display())
}

fn exact_project_settings(project_root: &std::path::Path) -> Settings {
    let preferred = project_root.join(".kordi").join("settings.json");
    let legacy = project_root.join(".bb-agent").join("settings.json");
    let path = if preferred.exists() {
        preferred
    } else if legacy.exists() {
        legacy
    } else {
        preferred
    };
    Settings::load_from_file(&path)
}

fn project_group_from_root(
    project_root: &std::path::Path,
    registered_name: Option<&str>,
) -> DesktopChatProjectGroup {
    let settings = exact_project_settings(project_root);
    let project_name = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            registered_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(ToString::to_string)
        .or_else(|| {
            project_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());
    let summary = settings
        .project_context
        .clone()
        .or_else(|| settings.project_system_prompt.clone())
        .unwrap_or_else(|| project_root.display().to_string());
    let background_system = settings.project_system_prompt.clone();
    let shared_sources = settings
        .project_shared_sources
        .iter()
        .map(|source| DesktopChatProjectSource {
            label: source.label.clone(),
            path: source.path.clone(),
            detail: source.detail.clone(),
        })
        .collect::<Vec<_>>();

    DesktopChatProjectGroup {
        id: project_group_id(project_root),
        name: project_name,
        root: project_root.display().to_string(),
        summary,
        background_system,
        shared_sources,
        sessions: Vec::new(),
    }
}

pub fn register_project(
    project_root: &std::path::Path,
    name: Option<&str>,
) -> Result<DesktopChatProjectGroup> {
    let conn = open_sessions_db()?;
    let group_id = project_group_id(project_root);
    kordi_session::store::upsert_project(
        &conn,
        &group_id,
        &project_root.display().to_string(),
        name,
    )?;
    Ok(project_group_from_root(project_root, name))
}

pub fn list_project_groups(_cwd: &std::path::Path) -> Result<Vec<DesktopChatProjectGroup>> {
    let conn = open_sessions_db()?;
    let rows = kordi_session::store::list_all_sessions(&conn)?;
    let registered_projects = kordi_session::store::list_projects(&conn)?;
    let mut groups: std::collections::BTreeMap<String, DesktopChatProjectGroup> =
        std::collections::BTreeMap::new();
    let mut group_sort_keys = std::collections::HashMap::<String, i64>::new();
    let mut session_sort_keys = std::collections::HashMap::<String, i64>::new();

    for project in registered_projects {
        let project_root = std::path::PathBuf::from(project.root.trim());
        let group_id = project_group_id(&project_root);
        groups
            .entry(group_id.clone())
            .or_insert_with(|| project_group_from_root(&project_root, project.name.as_deref()));
        group_sort_keys
            .entry(group_id)
            .or_insert_with(|| parse_db_timestamp_millis(&project.updated_at).unwrap_or_default());
    }

    for row in rows {
        if row.session_scope != "project" {
            continue;
        }
        let Some(project_root_value) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let sort_ts = session_sort_timestamp_ms(&conn, &row);
        let session_id = row.session_id.clone();
        let project_root = std::path::PathBuf::from(project_root_value);
        let group_id = project_group_id(&project_root);
        let summary_row = session_summary_from_row(&conn, row)?;

        let entry = groups
            .entry(group_id.clone())
            .or_insert_with(|| project_group_from_root(&project_root, None));
        entry.sessions.push(summary_row);
        session_sort_keys.insert(session_id, sort_ts);
        group_sort_keys
            .entry(group_id)
            .and_modify(|current| *current = (*current).max(sort_ts))
            .or_insert(sort_ts);
    }

    for group in groups.values_mut() {
        group.sessions.sort_by(|left, right| {
            let left_time = session_sort_keys.get(&left.id).copied().unwrap_or_default();
            let right_time = session_sort_keys
                .get(&right.id)
                .copied()
                .unwrap_or_default();
            right_time
                .cmp(&left_time)
                .then_with(|| right.updated_at_label.cmp(&left.updated_at_label))
        });
    }

    let mut result = groups.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| {
        let left_time = group_sort_keys.get(&left.id).copied().unwrap_or_default();
        let right_time = group_sort_keys.get(&right.id).copied().unwrap_or_default();
        right_time
            .cmp(&left_time)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(result)
}

pub(super) fn load_project_info(project_root: &std::path::Path) -> Option<DesktopChatProjectInfo> {
    let settings = exact_project_settings(project_root);
    let name = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            project_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());

    let shared_context = settings
        .project_context
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let background_system = settings
        .project_system_prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let shared_sources = settings
        .project_shared_sources
        .into_iter()
        .map(|source| DesktopChatProjectSource {
            label: source.label,
            path: source.path,
            detail: source.detail,
        })
        .collect::<Vec<_>>();

    Some(DesktopChatProjectInfo {
        name,
        root: project_root.display().to_string(),
        shared_context,
        background_system,
        shared_sources,
    })
}

fn format_db_timestamp(value: &str) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Local))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|dt| Local.from_local_datetime(&dt).single())
        });

    match parsed {
        Some(datetime) => {
            let today = Local::now().date_naive();
            if datetime.date_naive() == today {
                datetime.format("%H:%M").to_string()
            } else {
                datetime.format("%b %-d").to_string()
            }
        }
        None => value.to_string(),
    }
}

fn short_session_id(value: &str) -> String {
    value.chars().take(8).collect()
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    let truncated = value.chars().take(max_chars).collect::<String>();
    format!("{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_title_seed_matches_chat_title_rules() {
        assert_eq!(
            session_title_from_seed(
                "  plan the project session naming behavior with enough extra words  "
            )
            .as_deref(),
            Some("plan the project session naming behavior with enough")
        );
        assert_eq!(session_title_from_seed("   "), None);
    }

    #[test]
    fn placeholder_session_names_are_not_real_titles() {
        let row = kordi_session::store::SessionRow {
            session_id: "abcdef12-3456".to_string(),
            cwd: "/tmp/kordi".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            name: Some("Session abcdef12".to_string()),
            leaf_id: None,
            entry_count: 0,
            parent_session_id: None,
            parent_session_message_id: None,
            session_scope: "project".to_string(),
            project_root: Some("/tmp/project".to_string()),
        };
        assert_eq!(session_row_display_name(&row), None);

        let row = kordi_session::store::SessionRow {
            name: Some("New session".to_string()),
            ..row
        };
        assert_eq!(session_row_display_name(&row), None);
    }
}
