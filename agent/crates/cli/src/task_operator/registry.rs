#![allow(dead_code)]

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct TaskPath(String);

impl TaskPath {
    pub(crate) fn root() -> Self {
        Self("/root".to_string())
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        let trimmed = value.trim();
        if trimmed == "/root" || trimmed.starts_with("/root/") {
            Ok(Self(trimmed.trim_end_matches('/').to_string()))
        } else {
            bail!("task path must start with /root")
        }
    }

    pub(crate) fn join(&self, child_name: &str) -> Result<Self> {
        validate_task_name(child_name)?;
        Ok(Self(format!("{}/{}", self.0, child_name)))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    fn is_descendant_of(&self, parent: &TaskPath) -> bool {
        self.0
            .strip_prefix(parent.as_str())
            .is_some_and(|suffix| suffix.starts_with('/'))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TaskAgentStatus {
    Reserved,
    Running,
    Completed,
    Failed,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskAgentMetadata {
    pub(crate) path: TaskPath,
    pub(crate) title: String,
    pub(crate) status: TaskAgentStatus,
    pub(crate) write_scope: Vec<String>,
    pub(crate) summary: Option<String>,
}

impl TaskAgentStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }

    pub(crate) fn is_live(&self) -> bool {
        matches!(self, Self::Reserved | Self::Running)
    }
}

#[derive(Debug)]
pub(crate) struct TaskAgentRegistry {
    max_live_tasks: usize,
    agents: BTreeMap<TaskPath, TaskAgentMetadata>,
}

impl TaskAgentRegistry {
    pub(crate) fn new(max_live_tasks: usize) -> Self {
        Self {
            max_live_tasks,
            agents: BTreeMap::new(),
        }
    }

    pub(crate) fn reserve(
        &mut self,
        task_name: &str,
        title: &str,
        write_scope: Vec<String>,
    ) -> Result<TaskAgentMetadata> {
        self.reserve_under(TaskPath::root().as_str(), task_name, title, write_scope)
    }

    pub(crate) fn reserve_under(
        &mut self,
        parent_path: &str,
        task_name: &str,
        title: &str,
        write_scope: Vec<String>,
    ) -> Result<TaskAgentMetadata> {
        if self.live_count() >= self.max_live_tasks {
            bail!("maximum live task agents reached")
        }
        ensure_disjoint_write_scope(&self.agents, &write_scope)?;
        let parent = TaskPath::parse(parent_path)?;
        let path = parent.join(task_name)?;
        if self.agents.contains_key(&path) {
            bail!("task path `{}` already exists", path.as_str())
        }
        let metadata = TaskAgentMetadata {
            path: path.clone(),
            title: title.trim().to_string(),
            status: TaskAgentStatus::Reserved,
            write_scope,
            summary: None,
        };
        self.agents.insert(path, metadata.clone());
        Ok(metadata)
    }

    pub(crate) fn get(&self, path: &str) -> Result<&TaskAgentMetadata> {
        let path = TaskPath::parse(path)?;
        self.agents
            .get(&path)
            .ok_or_else(|| anyhow!("task path `{}` not found", path.as_str()))
    }

    pub(crate) fn mark_running(&mut self, path: &str) -> Result<()> {
        self.get_mut(path)?.status = TaskAgentStatus::Running;
        Ok(())
    }

    pub(crate) fn mark_completed(&mut self, path: &str, summary: Option<String>) -> Result<()> {
        let metadata = self.get_mut(path)?;
        metadata.status = TaskAgentStatus::Completed;
        metadata.summary = summary;
        Ok(())
    }

    pub(crate) fn mark_failed(&mut self, path: &str, summary: Option<String>) -> Result<()> {
        let metadata = self.get_mut(path)?;
        metadata.status = TaskAgentStatus::Failed;
        metadata.summary = summary;
        Ok(())
    }

    pub(crate) fn list(&self, path_prefix: Option<&str>) -> Result<Vec<TaskAgentMetadata>> {
        let prefix = path_prefix.map(TaskPath::parse).transpose()?;
        Ok(self
            .agents
            .iter()
            .filter(|(path, _)| {
                prefix
                    .as_ref()
                    .map(|prefix| path == &prefix || path.is_descendant_of(prefix))
                    .unwrap_or(true)
            })
            .map(|(_, metadata)| metadata.clone())
            .collect())
    }

    pub(crate) fn close(&mut self, path: &str) -> Result<()> {
        let path = TaskPath::parse(path)?;
        if !self.agents.contains_key(&path) {
            bail!("task path `{}` not found", path.as_str())
        }
        for (agent_path, metadata) in self.agents.iter_mut() {
            if agent_path == &path || agent_path.is_descendant_of(&path) {
                metadata.status = TaskAgentStatus::Closed;
            }
        }
        Ok(())
    }

    fn get_mut(&mut self, path: &str) -> Result<&mut TaskAgentMetadata> {
        let path = TaskPath::parse(path)?;
        self.agents
            .get_mut(&path)
            .ok_or_else(|| anyhow!("task path `{}` not found", path.as_str()))
    }

    fn live_count(&self) -> usize {
        self.agents
            .values()
            .filter(|metadata| metadata.status.is_live())
            .count()
    }
}

fn ensure_disjoint_write_scope(
    agents: &BTreeMap<TaskPath, TaskAgentMetadata>,
    write_scope: &[String],
) -> Result<()> {
    let requested = write_scope
        .iter()
        .filter_map(|scope| normalize_scope(scope))
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(());
    }

    for metadata in agents.values().filter(|metadata| metadata.status.is_live()) {
        for existing in metadata
            .write_scope
            .iter()
            .filter_map(|scope| normalize_scope(scope))
        {
            for requested_scope in &requested {
                if scopes_overlap(&existing, requested_scope) {
                    bail!(
                        "write scope overlaps running task `{}`: `{}` overlaps `{}`",
                        metadata.path.as_str(),
                        requested_scope,
                        existing
                    );
                }
            }
        }
    }
    Ok(())
}

fn normalize_scope(scope: &str) -> Option<String> {
    let normalized = scope.trim().trim_end_matches('/').to_string();
    (!normalized.is_empty()).then_some(normalized)
}

fn scopes_overlap(left: &str, right: &str) -> bool {
    left == right
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_task_name(task_name: &str) -> Result<()> {
    let valid = !task_name.is_empty()
        && task_name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if valid {
        Ok(())
    } else {
        bail!("task name must use lowercase letters, digits, and underscores")
    }
}

#[cfg(test)]
mod tests {
    use super::{TaskAgentRegistry, TaskAgentStatus, TaskPath};

    #[test]
    fn task_paths_start_at_root_and_join_child_names() {
        let root = TaskPath::root();
        assert_eq!(root.as_str(), "/root");
        assert_eq!(root.join("research").unwrap().as_str(), "/root/research");
    }

    #[test]
    fn registry_rejects_overlapping_live_write_scopes() {
        let mut registry = TaskAgentRegistry::new(4);
        registry
            .reserve(
                "writer",
                "Writer",
                vec!["agent/crates/tools/src".to_string()],
            )
            .unwrap();

        let error = registry
            .reserve(
                "nested_writer",
                "Nested writer",
                vec!["agent/crates/tools/src/task_operator".to_string()],
            )
            .unwrap_err()
            .to_string();

        assert!(error.contains("write scope overlaps"));

        registry.reserve("reader", "Reader", vec![]).unwrap();
    }

    #[test]
    fn registry_lists_and_updates_task_statuses() {
        let mut registry = TaskAgentRegistry::new(4);
        registry.reserve("research", "Research", vec![]).unwrap();
        registry.mark_running("/root/research").unwrap();
        registry
            .mark_completed("/root/research", Some("Found docs".to_string()))
            .unwrap();

        let listed = registry.list(Some("/root")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path.as_str(), "/root/research");
        assert_eq!(listed[0].status, TaskAgentStatus::Completed);
        assert_eq!(listed[0].summary.as_deref(), Some("Found docs"));
    }

    #[test]
    fn registry_reserves_unique_paths_and_enforces_limit() {
        let mut registry = TaskAgentRegistry::new(1);
        let first = registry.reserve("research", "Research", vec![]).unwrap();
        assert_eq!(first.path.as_str(), "/root/research");
        assert_eq!(first.status, TaskAgentStatus::Reserved);

        assert!(registry.reserve("research", "Duplicate", vec![]).is_err());
        assert!(registry.reserve("review", "Review", vec![]).is_err());
    }

    #[test]
    fn closing_parent_closes_descendants() {
        let mut registry = TaskAgentRegistry::new(4);
        registry.reserve("parent", "Parent", vec![]).unwrap();
        registry
            .reserve_under("/root/parent", "child", "Child", vec![])
            .unwrap();

        registry.close("/root/parent").unwrap();

        assert_eq!(
            registry.get("/root/parent").unwrap().status,
            TaskAgentStatus::Closed
        );
        assert_eq!(
            registry.get("/root/parent/child").unwrap().status,
            TaskAgentStatus::Closed
        );
    }
}
