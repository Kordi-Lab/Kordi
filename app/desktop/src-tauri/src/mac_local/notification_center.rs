//! Experimental Notification Center reader. The database is protected by
//! Full Disk Access; when it cannot be read the connector reports
//! `full_disk_access_missing` and the tool is absent. Nothing read here is
//! persisted: a locked database is copied to a private temporary directory
//! that is removed before the call returns.
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use kordi_tools::mac_local::{
    truncate_chars, MacNotificationsRequest, MAX_NOTIFICATIONS, MAX_NOTIFICATION_BODY_CHARS,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

/// Seconds between the Unix epoch and the Core Foundation epoch (2001-01-01).
const CF_EPOCH_OFFSET: f64 = 978_307_200.0;

pub(crate) fn default_db_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join("Library/Group Containers/group.com.apple.usernoted/db2/db")
    })
}

/// True only when the database file can actually be opened and read, which
/// on macOS requires Full Disk Access.
pub(crate) fn is_readable(path: &Path) -> bool {
    let mut byte = [0u8; 1];
    File::open(path)
        .and_then(|mut file| file.read(&mut byte))
        .is_ok_and(|read| read == 1)
}

struct TempCopy(PathBuf);

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const TEMP_PREFIX: &str = "kordi-nc-";
/// Copies older than this are left over from a crash and are removed.
const STALE_COPY_AGE: Duration = Duration::from_secs(10 * 60);

/// Removes private copies a previous run could not clean up, for example
/// after a crash. Recent copies may belong to a concurrent read and stay.
fn sweep_stale_copies(temp_root: &Path) {
    let Ok(entries) = std::fs::read_dir(temp_root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_COPY_AGE);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn copy_to_private_temp(path: &Path) -> Result<(TempCopy, PathBuf), String> {
    let dir = std::env::temp_dir().join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
    create_private_dir(&dir).map_err(|error| error.to_string())?;
    let guard = TempCopy(dir.clone());
    let target = dir.join("db");
    std::fs::copy(path, &target).map_err(|error| error.to_string())?;
    for suffix in ["-wal", "-shm"] {
        let mut source = path.as_os_str().to_owned();
        source.push(suffix);
        let mut copy = target.as_os_str().to_owned();
        copy.push(suffix);
        let _ = std::fs::copy(PathBuf::from(source), PathBuf::from(copy));
    }
    Ok((guard, target))
}

struct Row {
    data: Vec<u8>,
    delivered: f64,
    bundle_id: Option<String>,
}

fn query(connection: &Connection, since: f64, limit: usize) -> rusqlite::Result<Vec<Row>> {
    let mut statement = connection.prepare(
        "SELECT r.data, r.delivered_date, a.identifier FROM record r \
         LEFT JOIN app a ON a.app_id = r.app_id \
         WHERE r.delivered_date >= ?1 ORDER BY r.delivered_date DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![since, limit as i64], |row| {
        Ok(Row {
            data: row.get(0)?,
            delivered: row.get(1)?,
            bundle_id: row.get(2)?,
        })
    })?;
    rows.collect()
}

fn read_rows(path: &Path, since: f64, limit: usize) -> Result<Vec<Row>, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let direct = Connection::open_with_flags(path, flags).and_then(|connection| {
        connection.busy_timeout(std::time::Duration::from_millis(500))?;
        query(&connection, since, limit)
    });
    match direct {
        Ok(rows) => Ok(rows),
        Err(_) => {
            // The live database is often locked by usernoted; read a private copy.
            let (_guard, copy) = copy_to_private_temp(path)?;
            let connection =
                Connection::open_with_flags(&copy, flags).map_err(|error| error.to_string())?;
            query(&connection, since, limit).map_err(|error| error.to_string())
        }
    }
}

fn text(dictionary: &plist::Dictionary, key: &str) -> Option<String> {
    dictionary
        .get(key)
        .and_then(plist::Value::as_string)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Decodes one `record.data` binary plist. Returns `None` for rows whose
/// format is unknown; the caller counts them as skipped instead of failing.
fn decode(row: &Row) -> Option<Value> {
    let value = plist::Value::from_reader(std::io::Cursor::new(&row.data)).ok()?;
    let root = value.as_dictionary()?;
    let request = root.get("req").and_then(plist::Value::as_dictionary)?;
    let title = text(request, "titl");
    let subtitle = text(request, "subt");
    let body = text(request, "body").map(|body| truncate_chars(&body, MAX_NOTIFICATION_BODY_CHARS));
    if title.is_none() && body.is_none() {
        return None;
    }
    let app = text(root, "app").or_else(|| row.bundle_id.clone());
    let time =
        chrono::DateTime::from_timestamp((row.delivered + CF_EPOCH_OFFSET) as i64, 0).map(|time| {
            time.with_timezone(&chrono::Local)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
        });
    Some(json!({
        "app": app,
        "title": title,
        "subtitle": subtitle,
        "body": body,
        "time": time,
    }))
}

pub(crate) fn read_recent(path: &Path, request: &MacNotificationsRequest) -> Result<Value, String> {
    request.validate().map_err(|error| error.to_string())?;
    sweep_stale_copies(&std::env::temp_dir());
    if !is_readable(path) {
        return Err("Notification Center needs Full Disk Access. Allow Kordi in System Settings > Privacy & Security > Full Disk Access.".into());
    }
    let limit = request.limit.min(MAX_NOTIFICATIONS);
    let now = chrono::Utc::now().timestamp() as f64 - CF_EPOCH_OFFSET;
    let since = now - f64::from(request.hours) * 3600.0;
    let rows = read_rows(path, since, limit)?;
    let notifications: Vec<_> = rows.iter().filter_map(decode).collect();
    Ok(json!({
        "notifications": notifications,
        "skipped": rows.len() - notifications.len(),
        "experimental": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kordi-nc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record_blob(app: &str, title: &str, body: &str) -> Vec<u8> {
        let mut request = plist::Dictionary::new();
        request.insert("titl".into(), title.into());
        request.insert("body".into(), body.into());
        let mut root = plist::Dictionary::new();
        root.insert("app".into(), app.into());
        root.insert("req".into(), plist::Value::Dictionary(request));
        let mut bytes = Vec::new();
        plist::Value::Dictionary(root)
            .to_writer_binary(&mut bytes)
            .unwrap();
        bytes
    }

    #[cfg(unix)]
    #[test]
    fn notification_private_copy_dir_is_owner_only_and_stale_copies_are_swept() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir();
        let fresh = root.join(format!("{TEMP_PREFIX}fresh"));
        create_private_dir(&fresh).unwrap();
        let mode = std::fs::metadata(&fresh).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let stale = root.join(format!("{TEMP_PREFIX}stale"));
        create_private_dir(&stale).unwrap();
        let old = SystemTime::now() - STALE_COPY_AGE - Duration::from_secs(60);
        File::open(&stale).unwrap().set_modified(old).unwrap();
        let other = root.join("other-stale");
        std::fs::create_dir(&other).unwrap();
        File::open(&other).unwrap().set_modified(old).unwrap();
        sweep_stale_copies(&root);
        assert!(fresh.exists());
        assert!(!stale.exists());
        assert!(other.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notification_database_readability_requires_an_openable_file() {
        let dir = temp_dir();
        assert!(!is_readable(&dir.join("missing")));
        assert!(!is_readable(&dir));
        let empty = dir.join("empty");
        std::fs::write(&empty, b"").unwrap();
        assert!(!is_readable(&empty));
        std::fs::write(dir.join("db"), b"SQLite format 3\0").unwrap();
        assert!(is_readable(&dir.join("db")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn notification_reader_decodes_records_caps_bodies_and_skips_unknown_rows() {
        let dir = temp_dir();
        let path = dir.join("db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier TEXT);
                 CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, data BLOB, delivered_date REAL);
                 INSERT INTO app VALUES (1, 'com.apple.mail');",
            )
            .unwrap();
        let now = chrono::Utc::now().timestamp() as f64 - CF_EPOCH_OFFSET;
        let long_body = "b".repeat(900);
        for (data, delivered) in [
            (
                record_blob("com.apple.mail", "New mail", &long_body),
                now - 60.0,
            ),
            (b"not a plist".to_vec(), now - 120.0),
            (
                record_blob("com.apple.mail", "Old", "old"),
                now - 3.0 * 3600.0,
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO record (app_id, data, delivered_date) VALUES (1, ?1, ?2)",
                    rusqlite::params![data, delivered],
                )
                .unwrap();
        }
        drop(connection);
        let value = read_recent(
            &path,
            &MacNotificationsRequest {
                hours: 2,
                limit: 10,
            },
        )
        .unwrap();
        let notifications = value["notifications"].as_array().unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0]["app"], json!("com.apple.mail"));
        assert_eq!(notifications[0]["title"], json!("New mail"));
        assert_eq!(
            notifications[0]["body"].as_str().unwrap().chars().count(),
            MAX_NOTIFICATION_BODY_CHARS
        );
        assert_eq!(value["skipped"], json!(1));
        assert!(read_recent(
            &path,
            &MacNotificationsRequest {
                hours: 25,
                limit: 10
            }
        )
        .is_err());
        assert!(read_recent(
            &dir.join("missing"),
            &MacNotificationsRequest { hours: 1, limit: 1 }
        )
        .unwrap_err()
        .contains("Full Disk Access"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
