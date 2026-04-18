use crate::models::*;
use rusqlite::{params, Connection};

/// Default projects root: ~/bridges-projects/
pub fn projects_root() -> std::path::PathBuf {
    let base = directories::BaseDirs::new().expect("cannot determine home dir");
    base.home_dir().join("bridges-projects")
}

/// Get or create the project directory path for a slug.
pub fn project_dir_for_slug(slug: &str) -> std::path::PathBuf {
    projects_root().join(slug)
}

// ── Nodes ──

pub fn insert_node(conn: &Connection, node: &Node) {
    conn.execute(
        "INSERT OR REPLACE INTO nodes (node_id, display_name, runtime, endpoint, public_key, owner_principal_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            node.node_id,
            node.display_name,
            node.runtime,
            node.endpoint,
            node.public_key,
            node.owner_principal_id,
            node.created_at,
        ],
    )
    .expect("insert_node failed");
}

// ── Peers ──

pub fn list_peers(conn: &Connection) -> Vec<Peer> {
    let mut stmt = conn
        .prepare("SELECT node_id, display_name, runtime, endpoint, public_key, owner_name, trust_status, last_seen_at, created_at FROM peers")
        .expect("prepare list_peers");
    stmt.query_map([], |row| {
        Ok(Peer {
            node_id: row.get(0)?,
            display_name: row.get(1)?,
            runtime: row.get(2)?,
            endpoint: row.get(3)?,
            public_key: row.get(4)?,
            owner_name: row.get(5)?,
            trust_status: row.get(6)?,
            last_seen_at: row.get(7)?,
            created_at: row.get(8)?,
        })
    })
    .expect("query list_peers")
    .filter_map(|r| r.ok())
    .collect()
}

// ── Projects ──

pub fn insert_project(conn: &Connection, project: &Project) {
    conn.execute(
        "INSERT OR REPLACE INTO projects (project_id, slug, display_name, description, project_path, owner_principal_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            project.project_id,
            project.slug,
            project.display_name,
            project.description,
            project.project_path,
            project.owner_principal_id,
            project.status,
            project.created_at,
        ],
    )
    .expect("insert_project failed");
}

pub fn list_projects(conn: &Connection) -> Vec<Project> {
    let mut stmt = conn
        .prepare("SELECT project_id, slug, display_name, description, project_path, owner_principal_id, status, created_at FROM projects")
        .expect("prepare list_projects");
    stmt.query_map([], |row| {
        Ok(Project {
            project_id: row.get(0)?,
            slug: row.get(1)?,
            display_name: row.get(2)?,
            description: row.get(3)?,
            project_path: row.get(4)?,
            owner_principal_id: row.get(5)?,
            status: row.get(6)?,
            created_at: row.get(7)?,
        })
    })
    .expect("query list_projects")
    .filter_map(|r| r.ok())
    .collect()
}

/// Get the local filesystem path for a project by its ID.
pub fn get_project_path(conn: &Connection, project_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT project_path FROM projects WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )
    .ok()
    .flatten()
}

/// Get project path by slug.
pub fn get_project_path_by_slug(conn: &Connection, slug: &str) -> Option<String> {
    conn.query_row(
        "SELECT project_path FROM projects WHERE slug = ?1",
        params![slug],
        |row| row.get(0),
    )
    .ok()
    .flatten()
}
