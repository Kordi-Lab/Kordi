//! The memory scopes a session may save into (#1710).
//!
//! The `reflection` tool takes a scope id from the model. The desktop host
//! records, for every turn, the scope ids that turn may write; a save into
//! any other scope is refused. A session without a record (the CLI and TUI)
//! may save into its own conversation, the project of its working directory,
//! any group, and the account-wide global scope.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, RwLock};

use kordi_session::reflection_lessons::ReflectionScope;

use super::canonical_group_scope_id;

/// The scope ids one turn may save memories into.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AllowedMemoryScopes {
    /// Every id form of this conversation.
    pub conversation_ids: Vec<String>,
    /// The canonical group id, when the conversation is a group.
    pub group_id: Option<String>,
    /// The project root, when the session has a project.
    pub project_root: Option<String>,
    /// True for the owner's own request; a shared request may not change the
    /// owner's account-wide memories.
    pub allow_global: bool,
}

static ALLOWED_SCOPES: LazyLock<RwLock<HashMap<String, AllowedMemoryScopes>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Record the scopes the next turns of `runtime_session_id` may save into.
/// The latest record wins.
pub fn set_allowed_memory_scopes(runtime_session_id: &str, scopes: AllowedMemoryScopes) {
    let mut allowed = match ALLOWED_SCOPES.write() {
        Ok(allowed) => allowed,
        Err(poisoned) => poisoned.into_inner(),
    };
    allowed.insert(runtime_session_id.trim().to_string(), scopes);
}

fn allowed_memory_scopes(runtime_session_id: &str) -> Option<AllowedMemoryScopes> {
    let allowed = match ALLOWED_SCOPES.read() {
        Ok(allowed) => allowed,
        Err(poisoned) => poisoned.into_inner(),
    };
    allowed.get(runtime_session_id.trim()).cloned()
}

/// The project scope id for a working directory, as the prompt shows it.
pub(crate) fn project_scope_id_for_cwd(cwd: &Path) -> String {
    kordi_core::config::project_root(cwd)
        .unwrap_or_else(|| cwd.to_path_buf())
        .display()
        .to_string()
}

fn same_path(left: &str, right: &str) -> bool {
    Path::new(left.trim()) == Path::new(right.trim())
}

fn quoted(ids: &[&str]) -> String {
    ids.iter()
        .map(|id| format!("`{id}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Refuse a save into a scope this session may not write. `scope_id` is the
/// id the save will use (group ids already canonical). The error names the
/// allowed scope ids.
pub(crate) fn check_memory_scope(
    runtime_session_id: &str,
    cwd: &Path,
    scope: &ReflectionScope,
    scope_id: &str,
) -> Result<(), String> {
    let scope_id = scope_id.trim();
    let allowed = allowed_memory_scopes(runtime_session_id);
    let (permitted, allowed_ids) = match (scope, &allowed) {
        (ReflectionScope::Global, Some(allowed)) => (allowed.allow_global, Vec::new()),
        (ReflectionScope::Global, None) => (true, Vec::new()),
        (ReflectionScope::Conversation, Some(allowed)) => {
            let ids = allowed
                .conversation_ids
                .iter()
                .map(|id| id.trim().to_string())
                .collect::<Vec<_>>();
            (ids.iter().any(|id| id == scope_id), ids)
        }
        (ReflectionScope::Conversation, None) => {
            let id = runtime_session_id.trim().to_string();
            (id == scope_id, vec![id])
        }
        (ReflectionScope::Group, Some(allowed)) => {
            let id = allowed.group_id.as_deref().map(canonical_group_scope_id);
            (id.as_deref() == Some(scope_id), id.into_iter().collect())
        }
        (ReflectionScope::Group, None) => (true, Vec::new()),
        (ReflectionScope::Project, Some(allowed)) => {
            let root = allowed.project_root.clone();
            let permitted = root
                .as_deref()
                .is_some_and(|root| same_path(root, scope_id));
            (permitted, root.into_iter().collect())
        }
        (ReflectionScope::Project, None) => {
            let root = project_scope_id_for_cwd(cwd);
            (same_path(&root, scope_id), vec![root])
        }
    };
    if permitted {
        return Ok(());
    }
    let scope_name = scope.as_str();
    let allowed_ids = allowed_ids.iter().map(String::as_str).collect::<Vec<_>>();
    Err(match (scope, allowed_ids.is_empty()) {
        (ReflectionScope::Global, _) => {
            "This request cannot save a global memory. Save it in this conversation instead."
                .to_string()
        }
        (_, true) => format!("This chat has no {scope_name} scope to save into."),
        (_, false) => format!(
            "This chat cannot save a {scope_name} memory under `{scope_id}`. Allowed {scope_name} scope ids: {}.",
            quoted(&allowed_ids)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(session: &str, scope: ReflectionScope, scope_id: &str) -> Result<(), String> {
        check_memory_scope(session, Path::new("/no-such-dir/app"), &scope, scope_id)
    }

    #[test]
    fn a_session_without_a_record_saves_only_into_its_own_conversation_and_project() {
        let session = "allowed-scopes-cli";
        assert!(check(session, ReflectionScope::Conversation, session).is_ok());
        let error = check(session, ReflectionScope::Conversation, "other-session").unwrap_err();
        assert!(error.contains("`allowed-scopes-cli`"), "{error}");
        assert!(check(session, ReflectionScope::Project, "/no-such-dir/app/").is_ok());
        let error = check(session, ReflectionScope::Project, "/elsewhere").unwrap_err();
        assert!(error.contains("`/no-such-dir/app`"), "{error}");
        assert!(check(session, ReflectionScope::Group, "any-group").is_ok());
        assert!(check(session, ReflectionScope::Global, "account").is_ok());
    }

    #[test]
    fn a_recorded_session_saves_only_into_its_scopes() {
        let session = "allowed-scopes-desktop";
        set_allowed_memory_scopes(
            session,
            AllowedMemoryScopes {
                conversation_ids: vec![session.to_string(), "session:group:gs-a".to_string()],
                group_id: Some("cloud-group-a".to_string()),
                project_root: Some("/work/acme".to_string()),
                allow_global: false,
            },
        );
        assert!(check(session, ReflectionScope::Conversation, "session:group:gs-a").is_ok());
        let error = check(session, ReflectionScope::Conversation, "stranger").unwrap_err();
        assert!(
            error.contains("`allowed-scopes-desktop`, `session:group:gs-a`"),
            "{error}"
        );
        assert!(check(session, ReflectionScope::Group, "cloud-group-a").is_ok());
        let error = check(session, ReflectionScope::Group, "cloud-group-b").unwrap_err();
        assert!(error.contains("`cloud-group-a`"), "{error}");
        assert!(check(session, ReflectionScope::Project, "/work/acme").is_ok());
        assert!(check(session, ReflectionScope::Project, "/work/other").is_err());
        let error = check(session, ReflectionScope::Global, "account").unwrap_err();
        assert!(error.contains("global"), "{error}");

        set_allowed_memory_scopes(
            session,
            AllowedMemoryScopes {
                conversation_ids: vec![session.to_string()],
                allow_global: true,
                ..AllowedMemoryScopes::default()
            },
        );
        assert!(check(session, ReflectionScope::Global, "account").is_ok());
        let error = check(session, ReflectionScope::Group, "cloud-group-a").unwrap_err();
        assert_eq!(error, "This chat has no group scope to save into.");
        assert!(check(session, ReflectionScope::Project, "/work/acme").is_err());
    }
}
