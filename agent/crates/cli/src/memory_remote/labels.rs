//! Display labels for memory scopes (#1710).
//!
//! The `reflection` tool only knows a scope id. The desktop host records the
//! conversation title, group title, or project name behind each scope id it
//! prepares a turn for, and saves and uploads read the label from here.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, RwLock};

use kordi_session::reflection_lessons::ReflectionScope;

/// Labels derived from a message are cut to this many characters.
pub const MESSAGE_LABEL_MAX_CHARS: usize = 40;

static SCOPE_LABELS: LazyLock<RwLock<HashMap<(String, String), String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Record the label for a scope id. The latest label wins, so a renamed
/// conversation labels later saves with its new title. Blank values are
/// ignored.
pub fn remember_scope_label(scope: &str, scope_id: &str, label: &str) {
    let (scope_id, label) = (scope_id.trim(), label.trim());
    if scope_id.is_empty() || label.is_empty() {
        return;
    }
    let mut labels = match SCOPE_LABELS.write() {
        Ok(labels) => labels,
        Err(poisoned) => poisoned.into_inner(),
    };
    labels.insert((scope.to_string(), scope_id.to_string()), label.to_string());
}

fn remembered_scope_label(scope: &ReflectionScope, scope_id: &str) -> Option<String> {
    let labels = match SCOPE_LABELS.read() {
        Ok(labels) => labels,
        Err(poisoned) => poisoned.into_inner(),
    };
    labels
        .get(&(scope.as_str().to_string(), scope_id.trim().to_string()))
        .cloned()
}

/// A short label from a message, for a conversation that has no title yet.
pub fn label_from_message(text: &str) -> Option<String> {
    let label = kordi_session::naming::derive_session_title(text)?;
    let label = label.trim();
    if label.chars().count() <= MESSAGE_LABEL_MAX_CHARS {
        return (!label.is_empty()).then(|| label.to_string());
    }
    let cut = label
        .chars()
        .take(MESSAGE_LABEL_MAX_CHARS - 1)
        .collect::<String>();
    Some(format!("{}…", cut.trim_end()))
}

/// The display label for a scope: the label the host recorded, or for a
/// project the final path component.
pub(crate) fn scope_label_for(scope: &ReflectionScope, scope_id: &str) -> Option<String> {
    if *scope == ReflectionScope::Global {
        return None;
    }
    if let Some(label) = remembered_scope_label(scope, scope_id) {
        return Some(label);
    }
    match scope {
        ReflectionScope::Project => Path::new(scope_id.trim())
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
            .filter(|name| !name.is_empty()),
        // Global memories apply to the whole account and carry no label.
        ReflectionScope::Global | ReflectionScope::Conversation | ReflectionScope::Group => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_labels_are_short() {
        assert_eq!(
            label_from_message("Plan the launch").as_deref(),
            Some("Plan the launch")
        );
        let long = label_from_message(
            "Please help me rewrite the onboarding checklist for the new support hires",
        )
        .expect("label");
        assert!(long.chars().count() <= MESSAGE_LABEL_MAX_CHARS, "{long}");
        assert_eq!(label_from_message("   "), None);
    }
}
