//! Registers the attachments this device sent in local agent sessions before
//! attachment access tracking existed, so actions on older transcripts keep
//! working.

use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

use super::{is_protected_location, with_registry};

pub(super) const ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";

/// Local paths of the attachments this device sent in local agent sessions,
/// read from the session database's attachment context entries.
fn recorded_attachment_paths(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT payload FROM entries \
             WHERE type = 'custom_message' AND instr(payload, ?1) > 0",
        )
        .map_err(|error| error.to_string())?;
    let payloads = statement
        .query_map([ATTACHMENT_CONTEXT_CUSTOM_TYPE], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for payload in payloads.flatten() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        if entry["custom_type"] != ATTACHMENT_CONTEXT_CUSTOM_TYPE {
            continue;
        }
        let Some(attachments) = entry["details"]["attachments"].as_array() else {
            continue;
        };
        paths.extend(
            attachments
                .iter()
                .filter_map(|attachment| attachment["localPath"].as_str())
                .filter(|path| !path.trim().is_empty())
                .map(str::to_string),
        );
    }
    Ok(paths)
}

fn read_recorded_attachment_paths(database: &Path) -> Result<Vec<String>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    recorded_attachment_paths(&conn)
}

/// The local session database for the active Kordi storage root.
#[cfg(not(test))]
fn local_session_database() -> Option<PathBuf> {
    let settings = kordi_core::settings::Settings::load_global();
    let database = kordi_core::config::session_db_path(&settings.storage);
    database.is_file().then_some(database)
}

#[cfg(test)]
pub(super) static TEST_SESSION_DATABASE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
fn local_session_database() -> Option<PathBuf> {
    TEST_SESSION_DATABASE
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// Registers, once per local session database, the attachments this device
/// sent in local agent sessions before access tracking existed, so actions on
/// older transcripts keep working. Returns true when that added anything.
pub(super) fn seed_from_local_history() -> Result<bool, String> {
    let Some(database) = local_session_database() else {
        return Ok(false);
    };
    if with_registry(|registry| registry.seeded_histories.contains(&database))? {
        return Ok(false);
    }
    let recorded = read_recorded_attachment_paths(&database).unwrap_or_else(|error| {
        eprintln!("[kordi] Unable to read earlier attachments: {error}");
        Vec::new()
    });
    let usable: Vec<PathBuf> = recorded
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| !is_protected_location(path))
        .collect();
    with_registry(|registry| {
        if !registry.seeded_histories.insert(database) {
            return false;
        }
        let mut changed = false;
        for path in usable {
            changed |= registry.insert(path);
        }
        if changed {
            if let Err(error) = registry.persist() {
                eprintln!("[kordi] {error}");
            }
        }
        if let Err(error) = registry.persist_seeded_histories() {
            eprintln!("[kordi] {error}");
        }
        changed
    })
}
