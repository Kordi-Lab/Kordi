use anyhow::{Result, anyhow};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NewTask {
    pub task_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub involved_participants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredTask {
    pub task_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub status: String,
    pub involved_participants: Vec<String>,
}

pub fn upsert_task(conn: &Connection, task: NewTask) -> Result<StoredTask> {
    let task_id = task.task_id.trim();
    let title = task.title.trim();
    if task_id.is_empty() {
        return Err(anyhow!("task_id cannot be empty"));
    }
    if title.is_empty() {
        return Err(anyhow!("task title cannot be empty"));
    }

    let now = Utc::now().to_rfc3339();
    let participants_json = serde_json::to_string(&task.involved_participants)?;
    conn.execute(
        "INSERT INTO tasks (
             task_id, title, summary, status, involved_participants_json, created_at, updated_at, closed_at
         ) VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?5, NULL)
         ON CONFLICT(task_id) DO UPDATE SET
             title = excluded.title,
             summary = excluded.summary,
             status = 'open',
             involved_participants_json = excluded.involved_participants_json,
             updated_at = excluded.updated_at,
             closed_at = NULL",
        params![
            task_id,
            title,
            task.summary.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            participants_json,
            now,
        ],
    )?;

    get_task(conn, task_id)?.ok_or_else(|| anyhow!("task was not persisted"))
}

pub fn close_task(conn: &Connection, task_id: &str) -> Result<StoredTask> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(anyhow!("task_id cannot be empty"));
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = 'closed', updated_at = ?2, closed_at = ?2 WHERE task_id = ?1",
        params![task_id, now],
    )?;
    get_task(conn, task_id)?.ok_or_else(|| anyhow!("task not found: {task_id}"))
}

pub fn search_tasks(
    conn: &Connection,
    query: &str,
    status: Option<&str>,
) -> Result<Vec<StoredTask>> {
    let query = query.trim().to_lowercase();
    let status = status.map(str::trim).filter(|value| !value.is_empty());
    let mut stmt = conn.prepare(
        "SELECT task_id, title, summary, status, involved_participants_json
         FROM tasks
         WHERE (?1 = '' OR lower(task_id) LIKE ?2 OR lower(title) LIKE ?2 OR lower(coalesce(summary, '')) LIKE ?2)
           AND (?3 IS NULL OR status = ?3)
         ORDER BY updated_at DESC, created_at DESC, task_id ASC
         LIMIT 50",
    )?;
    let like_query = format!("%{query}%");
    let rows = stmt.query_map(params![query, like_query, status], read_task_row)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn get_task(conn: &Connection, task_id: &str) -> Result<Option<StoredTask>> {
    conn.query_row(
        "SELECT task_id, title, summary, status, involved_participants_json
         FROM tasks WHERE task_id = ?1",
        params![task_id],
        read_task_row,
    )
    .optional()
    .map_err(Into::into)
}

fn read_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredTask> {
    let participants_json: String = row.get(4)?;
    let involved_participants = serde_json::from_str(&participants_json).unwrap_or_default();
    Ok(StoredTask {
        task_id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        status: row.get(3)?,
        involved_participants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_round_trip_through_db() {
        let conn = Connection::open_in_memory().expect("conn");
        crate::schema::init_schema(&conn).expect("schema");

        upsert_task(
            &conn,
            NewTask {
                task_id: "finish-317".to_string(),
                title: "Finish Issue 317".to_string(),
                summary: Some("Fork flow".to_string()),
                involved_participants: vec!["Shuyang".to_string()],
            },
        )
        .expect("insert");

        let matches = search_tasks(&conn, "317", None).expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].status, "open");

        close_task(&conn, "finish-317").expect("close");
        let closed = search_tasks(&conn, "317", Some("closed")).expect("search closed");
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].status, "closed");
    }
}
