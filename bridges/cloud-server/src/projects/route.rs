//! Which Mac runs an agent request in a project session.
//!
//! Project files exist only on Macs that have the project folder, so the cloud
//! never answers these requests. The project Mac runs them while it is online.
//! While it is offline, any online Mac that publishes the same project ID (the
//! folder is bound there) may run them. When no such Mac is online, the request
//! fails right away with a reply that says which Mac to open.
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::PROJECT_DEVICE_ONLINE_SECONDS;

pub struct ProjectRoute {
    /// Opaque catalog ID of the project (`sha256(root)` on each Mac).
    pub project_id: String,
    pub project_name: String,
    /// Opaque ID of the worktree the project Mac runs this session in.
    pub workspace_id: Option<String>,
    pub project_device_id: String,
    pub project_device_name: String,
    /// Macs allowed to run the request, project Mac first.
    pub runners: Vec<String>,
}

impl ProjectRoute {
    pub fn admits(&self, device_id: &str) -> bool {
        self.runners.iter().any(|runner| runner == device_id)
    }

    pub fn unavailable_message(&self) -> String {
        format!(
            "Open Kordi on {device} to run this task in {project}, or add the {project} folder in Kordi on this Mac.",
            device = self.project_device_name,
            project = self.project_name,
        )
    }
}

type BindingRow = (String, String, String, Option<String>, Option<String>, bool);

/// `caller` is the device asking to run the request. It is online because it
/// is asking, so its own catalog counts even when its last publish is late.
pub async fn project_route(
    pool: &PgPool,
    account: &str,
    session: &str,
    caller: Option<&str>,
) -> Result<Option<ProjectRoute>, sqlx_core::Error> {
    let binding: Option<BindingRow> = query_as(
        "SELECT p.device_id, coalesce(project->>'id',''), coalesce(project->>'name','Project'), \
                project->'workspaces'->>$2, d.device_name, \
                coalesce(d.revoked_at IS NULL, FALSE) AND p.updated_at>now()-make_interval(secs=>$3) \
         FROM cloud_project_devices p LEFT JOIN cloud_devices d USING(device_id), jsonb_array_elements(p.projects) project \
         WHERE p.account_id=$1 AND (project->'sessions') ? $2 \
         ORDER BY p.updated_at DESC LIMIT 1",
    )
    .bind(account)
    .bind(session)
    .bind(PROJECT_DEVICE_ONLINE_SECONDS as f64)
    .fetch_optional(pool)
    .await?;
    let Some((device_id, project_id, project_name, workspace_id, device_name, online)) = binding
    else {
        return Ok(None);
    };
    let runners = if online || caller == Some(device_id.as_str()) {
        vec![device_id.clone()]
    } else if project_id.is_empty() {
        Vec::new()
    } else {
        query_as::<_, (String,)>(
            "SELECT p.device_id FROM cloud_project_devices p JOIN cloud_devices d USING(device_id) \
             WHERE p.account_id=$1 AND d.revoked_at IS NULL AND p.device_id<>$2 \
               AND (p.updated_at>now()-make_interval(secs=>$4) OR p.device_id=$5) \
               AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.projects) project WHERE project->>'id'=$3) \
             ORDER BY p.device_id",
        )
        .bind(account)
        .bind(&device_id)
        .bind(&project_id)
        .bind(PROJECT_DEVICE_ONLINE_SECONDS as f64)
        .bind(caller.unwrap_or(""))
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(device,)| device)
        .collect()
    };
    Ok(Some(ProjectRoute {
        project_id,
        project_name,
        workspace_id,
        project_device_id: device_id,
        project_device_name: device_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "the project Mac".to_string()),
        runners,
    }))
}
