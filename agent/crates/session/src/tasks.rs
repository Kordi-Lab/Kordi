use anyhow::{Result, anyhow};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewTask {
    pub session_id: String,
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub involved_participants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredTask {
    pub session_id: String,
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub status: String,
    pub involved_participants: Vec<String>,
}

fn clean_required(value: &str, label: &str) -> Result<String> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    Ok(cleaned.to_string())
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn upsert_task(conn: &Connection, task: NewTask) -> Result<StoredTask> {
    let session_id = clean_required(&task.session_id, "session_id")?;
    let task_id = clean_required(&task.task_id, "task_id")?;
    let title = clean_required(&task.title, "task title")?;
    let parent_task_id = clean_optional(task.parent_task_id.as_deref());
    let status = clean_optional(task.status.as_deref()).unwrap_or_else(|| "open".to_string());

    let now = Utc::now().to_rfc3339();
    let participants_json = serde_json::to_string(&task.involved_participants)?;
    conn.execute(
        "INSERT INTO tasks (
             session_id, task_id, parent_task_id, title, summary, status, involved_participants_json, created_at, updated_at, closed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, CASE WHEN ?6 = 'closed' THEN ?8 ELSE NULL END)
         ON CONFLICT(session_id, task_id) DO UPDATE SET
             session_id = excluded.session_id,
             parent_task_id = excluded.parent_task_id,
             title = excluded.title,
             summary = excluded.summary,
             status = excluded.status,
             involved_participants_json = excluded.involved_participants_json,
             updated_at = excluded.updated_at,
             closed_at = CASE WHEN excluded.status = 'closed' THEN excluded.updated_at ELSE NULL END",
        params![
            session_id,
            task_id,
            parent_task_id,
            title,
            task.summary.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            status,
            participants_json,
            now,
        ],
    )?;

    get_task(conn, &session_id, &task_id)?.ok_or_else(|| anyhow!("task was not persisted"))
}

pub fn close_task(conn: &Connection, session_id: &str, task_id: &str) -> Result<StoredTask> {
    let session_id = clean_required(session_id, "session_id")?;
    let task_id = clean_required(task_id, "task_id")?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = 'closed', updated_at = ?3, closed_at = ?3 WHERE session_id = ?1 AND task_id = ?2",
        params![session_id, task_id, now],
    )?;
    get_task(conn, &session_id, &task_id)?
        .ok_or_else(|| anyhow!("task not found in session {session_id}: {task_id}"))
}

pub fn search_tasks(
    conn: &Connection,
    session_id: &str,
    query: Option<&str>,
    status: Option<&str>,
    parent_task_id: Option<&str>,
) -> Result<Vec<StoredTask>> {
    let session_id = clean_required(session_id, "session_id")?;
    let query = query.map(str::trim).unwrap_or_default().to_lowercase();
    let status = status.map(str::trim).filter(|value| !value.is_empty());
    let parent_task_id = parent_task_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut stmt = conn.prepare(
        "SELECT session_id, task_id, parent_task_id, title, summary, status, involved_participants_json
         FROM tasks
         WHERE session_id = ?1
           AND (?2 = '' OR lower(task_id) LIKE ?3 OR lower(title) LIKE ?3 OR lower(coalesce(summary, '')) LIKE ?3)
           AND (?4 IS NULL OR status = ?4)
           AND (?5 IS NULL OR parent_task_id = ?5)
         ORDER BY updated_at DESC, created_at DESC, task_id ASC
         LIMIT 100",
    )?;
    let like_query = format!("%{query}%");
    let rows = stmt.query_map(
        params![session_id, query, like_query, status, parent_task_id],
        read_task_row,
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub fn get_task(conn: &Connection, session_id: &str, task_id: &str) -> Result<Option<StoredTask>> {
    conn.query_row(
        "SELECT session_id, task_id, parent_task_id, title, summary, status, involved_participants_json
         FROM tasks WHERE session_id = ?1 AND task_id = ?2",
        params![session_id.trim(), task_id.trim()],
        read_task_row,
    )
    .optional()
    .map_err(Into::into)
}

fn read_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredTask> {
    let participants_json: String = row.get(6)?;
    let involved_participants = serde_json::from_str(&participants_json).unwrap_or_default();
    Ok(StoredTask {
        session_id: row.get(0)?,
        task_id: row.get(1)?,
        parent_task_id: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        status: row.get(5)?,
        involved_participants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_round_trip_through_session_scoped_db() {
        let conn = Connection::open_in_memory().expect("conn");
        crate::schema::init_schema(&conn).expect("schema");

        upsert_task(
            &conn,
            NewTask {
                session_id: "session-a".to_string(),
                task_id: "task_a".to_string(),
                parent_task_id: None,
                title: "Finish Issue 317".to_string(),
                summary: Some("Fork flow".to_string()),
                status: Some("open".to_string()),
                involved_participants: vec!["Alex".to_string()],
            },
        )
        .expect("insert");
        upsert_task(
            &conn,
            NewTask {
                session_id: "session-b".to_string(),
                task_id: "task_b".to_string(),
                parent_task_id: None,
                title: "Finish Issue 317".to_string(),
                summary: Some("Other session".to_string()),
                status: Some("open".to_string()),
                involved_participants: vec!["Other".to_string()],
            },
        )
        .expect("insert other session");

        let matches = search_tasks(&conn, "session-a", Some("317"), None, None).expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].task_id, "task_a");
        assert_eq!(matches[0].status, "open");

        close_task(&conn, "session-a", "task_a").expect("close");
        let closed = search_tasks(&conn, "session-a", Some("317"), Some("closed"), None)
            .expect("search closed");
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].status, "closed");
        let still_open_elsewhere =
            search_tasks(&conn, "session-b", Some("317"), Some("open"), None)
                .expect("search other");
        assert_eq!(still_open_elsewhere.len(), 1);
        assert_eq!(still_open_elsewhere[0].task_id, "task_b");
    }

    #[test]
    fn same_task_id_can_exist_in_different_sessions() {
        let conn = Connection::open_in_memory().expect("conn");
        crate::schema::init_schema(&conn).expect("schema");

        for (session_id, title) in [
            ("session-a", "Session A task"),
            ("session-b", "Session B task"),
        ] {
            upsert_task(
                &conn,
                NewTask {
                    session_id: session_id.to_string(),
                    task_id: "shared_remote_id".to_string(),
                    parent_task_id: None,
                    title: title.to_string(),
                    summary: None,
                    status: Some("open".to_string()),
                    involved_participants: Vec::new(),
                },
            )
            .expect("insert task");
        }

        let session_a =
            search_tasks(&conn, "session-a", Some("shared"), None, None).expect("session a");
        let session_b =
            search_tasks(&conn, "session-b", Some("shared"), None, None).expect("session b");
        assert_eq!(session_a[0].title, "Session A task");
        assert_eq!(session_b[0].title, "Session B task");
    }

    #[test]
    fn task_search_without_query_lists_current_session_tasks_and_subtasks() {
        let conn = Connection::open_in_memory().expect("conn");
        crate::schema::init_schema(&conn).expect("schema");

        upsert_task(
            &conn,
            NewTask {
                session_id: "session-a".to_string(),
                task_id: "task_parent".to_string(),
                parent_task_id: None,
                title: "Parent task".to_string(),
                summary: None,
                status: Some("open".to_string()),
                involved_participants: Vec::new(),
            },
        )
        .expect("insert parent");
        upsert_task(
            &conn,
            NewTask {
                session_id: "session-a".to_string(),
                task_id: "task_child".to_string(),
                parent_task_id: Some("task_parent".to_string()),
                title: "Child task".to_string(),
                summary: None,
                status: Some("waiting".to_string()),
                involved_participants: Vec::new(),
            },
        )
        .expect("insert child");

        let listed = search_tasks(&conn, "session-a", None, None, None).expect("list all");
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .any(|task| task.task_id == "task_parent" && task.parent_task_id.is_none())
        );
        assert!(listed.iter().any(|task| task.task_id == "task_child"
            && task.parent_task_id.as_deref() == Some("task_parent")));
    }
}
