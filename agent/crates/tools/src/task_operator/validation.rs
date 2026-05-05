use std::collections::HashSet;

use kordi_core::error::{KordiError, KordiResult};

use super::models::TaskManifestTask;

pub fn validate_manifest_tasks(tasks: &[TaskManifestTask]) -> KordiResult<()> {
    if tasks.is_empty() {
        return Err(KordiError::Tool(
            "manifest must contain at least one task".to_string(),
        ));
    }

    let mut ids = HashSet::new();
    for task in tasks {
        validate_task_id(&task.task_id)?;
        if !ids.insert(task.task_id.as_str()) {
            return Err(KordiError::Tool(format!(
                "duplicate task_id `{}`",
                task.task_id
            )));
        }
        if task.title.trim().is_empty() {
            return Err(KordiError::Tool(format!(
                "task `{}` title cannot be empty",
                task.task_id
            )));
        }
        if task.summary.trim().is_empty() {
            return Err(KordiError::Tool(format!(
                "task `{}` summary cannot be empty",
                task.task_id
            )));
        }
    }

    for task in tasks {
        for dependency in &task.dependencies {
            if dependency == &task.task_id {
                return Err(KordiError::Tool(format!(
                    "task `{}` cannot depend on itself",
                    task.task_id
                )));
            }
            if !ids.contains(dependency.as_str()) {
                return Err(KordiError::Tool(format!(
                    "task `{}` has unknown dependency `{}`",
                    task.task_id, dependency
                )));
            }
        }
    }

    validate_write_scope_overlaps(tasks)?;
    Ok(())
}

fn validate_task_id(task_id: &str) -> KordiResult<()> {
    let valid = !task_id.is_empty()
        && task_id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if valid {
        Ok(())
    } else {
        Err(KordiError::Tool(format!(
            "invalid task_id `{task_id}`; use lowercase letters, digits, and underscores"
        )))
    }
}

fn validate_write_scope_overlaps(tasks: &[TaskManifestTask]) -> KordiResult<()> {
    let scopes = tasks
        .iter()
        .flat_map(|task| {
            task.write_scope.iter().filter_map(|scope| {
                normalize_scope(scope).map(|normalized| (task.task_id.as_str(), normalized))
            })
        })
        .collect::<Vec<_>>();

    for (index, (left_task, left_scope)) in scopes.iter().enumerate() {
        for (right_task, right_scope) in scopes.iter().skip(index + 1) {
            if left_task == right_task {
                continue;
            }
            if scopes_overlap(left_scope, right_scope) {
                return Err(KordiError::Tool(format!(
                    "overlapping write_scope `{left_scope}` and `{right_scope}`"
                )));
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

#[cfg(test)]
mod tests {
    use super::validate_manifest_tasks;
    use crate::task_operator::models::{TaskManifestTask, TaskRisk};

    fn task(task_id: &str, dependencies: Vec<&str>, write_scope: Vec<&str>) -> TaskManifestTask {
        TaskManifestTask {
            task_id: task_id.to_string(),
            title: format!("Task {task_id}"),
            summary: "Do the task".to_string(),
            dependencies: dependencies.into_iter().map(str::to_string).collect(),
            write_scope: write_scope.into_iter().map(str::to_string).collect(),
            risk: TaskRisk::Medium,
            estimated_input_tokens: 100,
            estimated_output_tokens: 50,
        }
    }

    #[test]
    fn validation_rejects_duplicate_task_ids() {
        let tasks = vec![task("one", vec![], vec![]), task("one", vec![], vec![])];
        let error = validate_manifest_tasks(&tasks).unwrap_err().to_string();
        assert!(error.contains("duplicate task_id"));
    }

    #[test]
    fn validation_rejects_unknown_dependencies_and_self_dependencies() {
        let unknown = vec![task("one", vec!["missing"], vec![])];
        assert!(
            validate_manifest_tasks(&unknown)
                .unwrap_err()
                .to_string()
                .contains("unknown dependency")
        );

        let self_dep = vec![task("one", vec!["one"], vec![])];
        assert!(
            validate_manifest_tasks(&self_dep)
                .unwrap_err()
                .to_string()
                .contains("cannot depend on itself")
        );
    }

    #[test]
    fn validation_rejects_invalid_ids_and_overlapping_write_scopes() {
        let invalid = vec![task("Bad-ID", vec![], vec![])];
        assert!(
            validate_manifest_tasks(&invalid)
                .unwrap_err()
                .to_string()
                .contains("invalid task_id")
        );

        let overlap = vec![
            task("one", vec![], vec!["agent/crates/tools/src"]),
            task("two", vec![], vec!["agent/crates/tools/src/task_operator"]),
        ];
        assert!(
            validate_manifest_tasks(&overlap)
                .unwrap_err()
                .to_string()
                .contains("overlapping write_scope")
        );
    }
}
