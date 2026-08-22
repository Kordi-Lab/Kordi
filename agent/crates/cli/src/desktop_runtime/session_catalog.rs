use anyhow::Result;
use chrono::{Local, TimeZone};
use kordi_core::settings::Settings;

use super::transcript::load_session_messages;
use super::{
    DesktopChatMessage, DesktopChatProjectGroup, DesktopChatProjectInfo, DesktopChatProjectSource,
    DesktopChatSessionSummary,
};

mod summary;
use summary::session_summary_from_row;

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

pub(super) fn session_activity_timestamp_ms(
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
    let Some(name) = row.name.as_deref() else {
        return true;
    };
    if kordi_session::naming::is_raw_session_identifier(name, &row.session_id)
        || kordi_session::naming::is_explicit_placeholder_session_title(name)
    {
        return true;
    }
    row.title_source == kordi_session::store::SessionTitleSource::Placeholder
        || (matches!(
            row.title_source,
            kordi_session::store::SessionTitleSource::Auto
                | kordi_session::store::SessionTitleSource::Legacy
        ) && kordi_session::naming::is_placeholder_or_weak_legacy_title(name, &row.session_id))
}

pub(super) fn session_row_display_name(row: &kordi_session::store::SessionRow) -> Option<String> {
    if is_placeholder_session_name(row) {
        return None;
    }
    row.name.clone().filter(|value| !value.trim().is_empty())
}

pub(super) fn session_title_from_seed(value: &str) -> Option<String> {
    kordi_session::naming::derive_session_title(value)
}

pub(super) fn session_title_from_messages(messages: &[DesktopChatMessage]) -> Option<String> {
    messages
        .iter()
        .filter(|message| message.role == "user")
        .find_map(|message| {
            session_title_from_seed(&message.text).or_else(|| {
                kordi_session::naming::attachment_session_title(
                    message.attachments.len(),
                    message
                        .attachments
                        .iter()
                        .any(|attachment| attachment.kind == "image"),
                )
            })
        })
}

pub(super) fn repair_session_title_from_history(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> Result<Option<String>> {
    if row.title_source == kordi_session::store::SessionTitleSource::Legacy
        && row
            .name
            .as_deref()
            .is_some_and(kordi_session::naming::is_known_legacy_auto_title)
    {
        // A v10 row can already have been migrated by an earlier build. Clear
        // only recognized old auto-title shapes so the shared policy can
        // backfill them without risking a user-authored legacy title.
        kordi_session::store::set_session_title(
            conn,
            &row.session_id,
            None,
            kordi_session::store::SessionTitleSource::Placeholder,
            None,
        )?;
    }
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
        if let Some((title, entry_id)) = first_post_fork_user_title(conn, row)? {
            kordi_session::store::set_auto_session_name(
                conn,
                &row.session_id,
                &title,
                Some(&entry_id),
            )?;
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
    kordi_session::store::set_auto_session_name(conn, &row.session_id, &title, None)?;
    Ok(Some(title))
}

fn first_post_fork_user_title(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> Result<Option<(String, String)>> {
    let Some(anchor) = row.parent_session_message_id.as_deref() else {
        return Ok(None);
    };
    let entries = kordi_session::store::get_entries(conn, &row.session_id)?;
    let anchor_seq = entries
        .iter()
        .find(|entry| entry.entry_id == anchor)
        .map(|entry| entry.seq);
    let fork_created_at_ms = parse_db_timestamp_millis(&row.created_at);
    for entry_row in entries.iter().filter(|entry| {
        if entry.entry_type != "message" {
            return false;
        }
        if let Some(anchor_seq) = anchor_seq {
            return entry.seq > anchor_seq;
        }
        // Canonical-rooted forks store the stable canonical anchor in the
        // local session row, but intentionally do not duplicate the
        // inherited canonical snapshot into the runtime database. In that
        // case every local entry created at or after the fork shell is a
        // post-fork entry and is eligible to name the child session.
        fork_created_at_ms.is_none_or(|created_at_ms| {
            parse_db_timestamp_millis(&entry.timestamp)
                .is_none_or(|entry_at_ms| entry_at_ms >= created_at_ms)
        })
    }) {
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
            return Ok(Some((title, entry_row.entry_id.clone())));
        }
    }
    Ok(None)
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

    if row.session_scope == "project"
        && let Some(project_root) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Ok(std::path::PathBuf::from(project_root));
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
        session_activity_timestamp_ms(&conn, right)
            .cmp(&session_activity_timestamp_ms(&conn, left))
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

        let sort_ts = session_activity_timestamp_ms(&conn, &row);
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

pub(super) fn fallback_session_display_title(row: &kordi_session::store::SessionRow) -> String {
    if row.entry_count <= 0 {
        return "New chat".to_string();
    }
    let date = chrono::DateTime::parse_from_rfc3339(&row.created_at)
        .map(|value| value.with_timezone(&Local).format("%b %-d").to_string())
        .unwrap_or_else(|_| "recently".to_string());
    format!("Chat with My Kordi · {date}")
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
    use chrono::Utc;
    use kordi_core::types::{
        AgentMessage, ContentBlock, EntryBase, EntryId, SessionEntry, UserMessage,
    };

    fn user_entry(parent_id: Option<&str>, text: &str) -> SessionEntry {
        let now = Utc::now();
        SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: parent_id.map(|value| EntryId(value.to_string())),
                timestamp: now,
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                timestamp: now.timestamp_millis(),
            }),
        }
    }

    #[test]
    fn session_title_seed_matches_chat_title_rules() {
        assert_eq!(
            session_title_from_seed(
                "  plan the project session naming behavior with enough extra words  "
            )
            .as_deref(),
            Some("Plan the project session naming behavior with e…")
        );
        assert_eq!(session_title_from_seed("   "), None);
        assert_eq!(session_title_from_seed("hello"), None);
    }

    #[test]
    fn placeholder_session_names_are_not_real_titles() {
        let row = kordi_session::store::SessionRow {
            session_id: "abcdef12-3456".to_string(),
            cwd: "/tmp/kordi".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            name: Some("Session abcdef12".to_string()),
            title_source: kordi_session::store::SessionTitleSource::Legacy,
            title_revision: 1,
            title_policy_version: 1,
            title_generated_from_entry_id: None,
            title_updated_at: None,
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

        let row = kordi_session::store::SessionRow {
            name: Some("hello".to_string()),
            title_source: kordi_session::store::SessionTitleSource::Manual,
            ..row
        };
        assert_eq!(session_row_display_name(&row).as_deref(), Some("hello"));

        let row = kordi_session::store::SessionRow {
            name: Some("New session".to_string()),
            ..row
        };
        assert_eq!(session_row_display_name(&row), None);
    }

    #[test]
    fn fallback_title_is_human_readable_and_never_exposes_the_session_id() {
        let row = kordi_session::store::SessionRow {
            session_id: "e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83".to_string(),
            cwd: "/tmp/kordi".to_string(),
            created_at: "2026-07-15T12:00:00Z".to_string(),
            updated_at: "2026-07-15T12:00:00Z".to_string(),
            name: None,
            title_source: kordi_session::store::SessionTitleSource::Placeholder,
            title_revision: 0,
            title_policy_version: 1,
            title_generated_from_entry_id: None,
            title_updated_at: None,
            leaf_id: None,
            entry_count: 2,
            parent_session_id: None,
            parent_session_message_id: None,
            session_scope: "chat".to_string(),
            project_root: None,
        };

        let title = fallback_session_display_title(&row);
        assert!(title.starts_with("Chat with My Kordi · "));
        assert!(!title.contains(&row.session_id));
    }

    #[test]
    fn session_summary_exposes_numeric_last_activity_timestamp() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let session_id =
            kordi_session::store::create_session(&conn, "/tmp/kordi").expect("session");
        let entry = user_entry(None, "inspect the active session ordering");
        kordi_session::store::append_entry(&conn, &session_id, &entry).expect("append entry");
        let row = kordi_session::store::get_session(&conn, &session_id)
            .expect("row")
            .expect("session exists");
        let expected_activity_at_ms = session_activity_timestamp_ms(&conn, &row);

        let summary = session_summary_from_row(&conn, row).expect("session summary");

        assert!(expected_activity_at_ms > 0);
        assert_eq!(summary.updated_at_ms, expected_activity_at_ms);
    }

    #[test]
    fn known_legacy_first_prompt_is_backfilled_but_manual_like_legacy_title_is_preserved() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let session_id =
            kordi_session::store::create_session(&conn, "/tmp/kordi").expect("session");
        let entry = user_entry(None, "which model are you");
        kordi_session::store::append_entry(&conn, &session_id, &entry).expect("append entry");
        conn.execute(
            "UPDATE sessions
             SET name = 'which model are you', title_source = 'legacy', title_revision = 1
             WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .expect("seed legacy title");
        let row = kordi_session::store::get_session(&conn, &session_id)
            .expect("row")
            .expect("session exists");

        assert_eq!(
            repair_session_title_from_history(&conn, &row).expect("repair title"),
            Some("Model and identity".to_string())
        );
        let repaired = kordi_session::store::get_session(&conn, &session_id)
            .expect("repaired row")
            .expect("session exists");
        assert_eq!(
            repaired.title_source,
            kordi_session::store::SessionTitleSource::Auto
        );

        kordi_session::store::set_session_name(&conn, &session_id, Some("Release validation plan"))
            .expect("manual rename");
        let manual = kordi_session::store::get_session(&conn, &session_id)
            .expect("manual row")
            .expect("session exists");
        assert_eq!(
            repair_session_title_from_history(&conn, &manual).expect("preserve manual title"),
            Some("Release validation plan".to_string())
        );
    }

    #[test]
    fn fork_title_skips_inherited_and_low_information_messages() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let source_id =
            kordi_session::store::create_session(&conn, "/tmp/kordi").expect("source session");
        let source = user_entry(None, "Parent release discussion");
        let source_entry_id = source.base().id.to_string();
        kordi_session::store::append_entry(&conn, &source_id, &source).expect("source entry");
        let fork = kordi_session::store::fork_session_from_entry(
            &conn,
            &source_id,
            &source_entry_id,
            "/tmp/kordi",
        )
        .expect("fork session");
        let greeting = user_entry(Some(&source_entry_id), "hello");
        let greeting_id = greeting.base().id.to_string();
        kordi_session::store::append_entry(&conn, &fork.session_id, &greeting).expect("greeting");
        let topic = user_entry(Some(&greeting_id), "diagnose memory leak in Node process");
        let topic_id = topic.base().id.to_string();
        kordi_session::store::append_entry(&conn, &fork.session_id, &topic).expect("topic");
        let row = kordi_session::store::get_session(&conn, &fork.session_id)
            .expect("fork row")
            .expect("fork exists");

        assert_eq!(
            first_post_fork_user_title(&conn, &row).expect("derive fork title"),
            Some(("Diagnose memory leak in Node process".to_string(), topic_id))
        );
    }

    #[test]
    fn canonical_fork_title_uses_first_local_user_message_when_anchor_is_not_in_runtime_store() {
        let conn = kordi_session::store::open_memory().expect("session database");
        let fork_id = "session:fork:canonical";
        kordi_session::store::create_session_with_id_parent_and_message(
            &conn,
            fork_id,
            "/tmp/kordi",
            Some("session:canonical-parent"),
            Some("msg:canonical-parent-agent"),
        )
        .expect("canonical fork shell");
        let topic = user_entry(None, "debug nested fork lineage");
        let topic_id = topic.base().id.to_string();
        kordi_session::store::append_entry(&conn, fork_id, &topic).expect("new fork message");
        let row = kordi_session::store::get_session(&conn, fork_id)
            .expect("fork row")
            .expect("fork exists");

        assert_eq!(
            first_post_fork_user_title(&conn, &row).expect("derive canonical fork title"),
            Some(("Debug nested fork lineage".to_string(), topic_id))
        );
    }
}
