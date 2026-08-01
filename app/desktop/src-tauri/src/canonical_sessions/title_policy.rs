//! Canonical session title precedence and metadata reconciliation policy.

use serde_json::{Map, Value};

use super::{now_ms, CanonicalSession};

fn normalized_session_title_source(value: Option<&str>) -> Option<&'static str> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "placeholder" => Some("placeholder"),
        "auto" => Some("auto"),
        "imported" => Some("imported"),
        "external" => Some("external"),
        "legacy" => Some("legacy"),
        "manual" => Some("manual"),
        _ => None,
    }
}

fn explicit_session_title_source(
    metadata: &Map<String, Value>,
    kind: &str,
) -> Option<&'static str> {
    normalized_session_title_source(
        metadata
            .get("sessionTitleSource")
            .and_then(Value::as_str)
            .or_else(|| {
                (kind != "group")
                    .then(|| metadata.get("titleSource").and_then(Value::as_str))
                    .flatten()
            }),
    )
}

fn title_source_precedence(source: &str) -> u8 {
    match source {
        "manual" => 4,
        "imported" | "external" => 3,
        "legacy" => 2,
        "auto" => 1,
        _ => 0,
    }
}

fn canonical_title_is_placeholder(kind: &str, title: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    kordi_session::naming::is_placeholder_or_weak_legacy_title(title, "")
        || (kind == "group" && normalized == "group")
        || (matches!(kind, "self-agent" | "project")
            && matches!(
                normalized.as_str(),
                "kordi" | "my kordi" | "my agent" | "my kordi session" | "my agent session"
            ))
}

fn inferred_session_title_source(kind: &str, title: &str) -> &'static str {
    if canonical_title_is_placeholder(kind, title) {
        "placeholder"
    } else if matches!(kind, "direct-person" | "direct-agent" | "relationship") {
        "external"
    } else {
        "legacy"
    }
}

fn title_metadata_i64(metadata: &Map<String, Value>, key: &str) -> i64 {
    metadata
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn title_metadata_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn incoming_title_actor_wins(existing: Option<&str>, incoming: Option<&str>) -> bool {
    match (existing, incoming) {
        (Some(existing), Some(incoming)) => incoming < existing,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn copy_title_metadata(target: &mut Map<String, Value>, source: &Map<String, Value>, kind: &str) {
    for key in [
        "sessionTitleSource",
        "sessionTitleRevision",
        "sessionTitlePolicyVersion",
        "sessionTitleUpdatedAtMs",
        "sessionTitleUpdatedByAccountId",
        "sessionTitleGeneratedFromMessageId",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        } else {
            target.remove(key);
        }
    }
    if kind != "group" {
        if let Some(value) = source.get("titleSource") {
            target.insert("titleSource".to_string(), value.clone());
        } else {
            target.remove("titleSource");
        }
    }
}

fn preserve_string_metadata_key(
    target: &mut Map<String, Value>,
    existing: &Map<String, Value>,
    key: &str,
) {
    if target
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if let Some(value) = existing
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn preserve_metadata_key(
    target: &mut Map<String, Value>,
    existing: &Map<String, Value>,
    key: &str,
) {
    if target.get(key).is_some() {
        return;
    }
    if let Some(value) = existing.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

pub(super) fn reconcile_session_title_metadata(
    existing_session: Option<&CanonicalSession>,
    kind: &str,
    incoming_title: String,
    metadata: Option<Value>,
) -> (String, Option<Value>) {
    let existing_metadata = existing_session
        .and_then(|session| session.metadata.as_ref())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut next_metadata = match metadata {
        Some(Value::Object(map)) => map,
        Some(other) => return (incoming_title, Some(other)),
        None => Map::new(),
    };

    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "customName");
    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "groupId");
    preserve_string_metadata_key(&mut next_metadata, &existing_metadata, "groupSpaceId");
    preserve_metadata_key(
        &mut next_metadata,
        &existing_metadata,
        "groupNameUpdatedAtMs",
    );
    preserve_metadata_key(&mut next_metadata, &existing_metadata, "fork");
    if next_metadata.get("fork").is_some() {
        if let Some(Value::String(existing_created_from)) = existing_metadata.get("createdFrom") {
            if existing_created_from.contains("fork") {
                next_metadata.insert(
                    "createdFrom".to_string(),
                    Value::String(existing_created_from.clone()),
                );
            }
        }
    }

    let incoming_explicit_source = explicit_session_title_source(&next_metadata, kind);
    let incoming_source = incoming_explicit_source.unwrap_or_else(|| {
        if matches!(kind, "self-agent" | "project")
            && !canonical_title_is_placeholder(kind, &incoming_title)
        {
            "auto"
        } else {
            inferred_session_title_source(kind, &incoming_title)
        }
    });
    let incoming_source = if matches!(incoming_source, "auto" | "legacy")
        && canonical_title_is_placeholder(kind, &incoming_title)
    {
        "placeholder"
    } else {
        incoming_source
    };
    let incoming_revision = title_metadata_i64(&next_metadata, "sessionTitleRevision");
    let incoming_updated_at = title_metadata_i64(&next_metadata, "sessionTitleUpdatedAtMs");
    let incoming_updated_by =
        title_metadata_string(&next_metadata, "sessionTitleUpdatedByAccountId");

    let Some(existing_session) = existing_session else {
        let revision = if incoming_source == "placeholder" {
            0
        } else {
            incoming_revision.max(1)
        };
        next_metadata.insert(
            "sessionTitleSource".to_string(),
            Value::String(incoming_source.to_string()),
        );
        if kind != "group" {
            next_metadata.insert(
                "titleSource".to_string(),
                Value::String(incoming_source.to_string()),
            );
        }
        next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
        next_metadata.insert(
            "sessionTitlePolicyVersion".to_string(),
            Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
        );
        next_metadata
            .entry("sessionTitleUpdatedAtMs".to_string())
            .or_insert_with(|| Value::from(now_ms()));
        return (incoming_title, Some(Value::Object(next_metadata)));
    };

    let existing_source = explicit_session_title_source(&existing_metadata, kind)
        .unwrap_or_else(|| inferred_session_title_source(kind, &existing_session.title));
    let existing_source = if matches!(existing_source, "auto" | "legacy")
        && canonical_title_is_placeholder(kind, &existing_session.title)
    {
        "placeholder"
    } else {
        existing_source
    };
    let existing_revision = title_metadata_i64(&existing_metadata, "sessionTitleRevision");
    let existing_updated_at = title_metadata_i64(&existing_metadata, "sessionTitleUpdatedAtMs");
    let existing_updated_by =
        title_metadata_string(&existing_metadata, "sessionTitleUpdatedByAccountId");
    let incoming_is_explicit = incoming_explicit_source.is_some();
    let incoming_wins = if !incoming_is_explicit {
        if matches!(kind, "self-agent" | "project") {
            existing_source == "placeholder"
                && !canonical_title_is_placeholder(kind, &incoming_title)
        } else {
            !matches!(existing_source, "manual" | "imported")
        }
    } else {
        match title_source_precedence(incoming_source)
            .cmp(&title_source_precedence(existing_source))
        {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => match incoming_source {
                "auto" => {
                    (incoming_revision > existing_revision && incoming_revision <= 2)
                        || canonical_title_is_placeholder(kind, &existing_session.title)
                }
                "manual" | "imported" | "external" | "legacy" => {
                    incoming_updated_at > existing_updated_at
                        || (incoming_updated_at == existing_updated_at
                            && (incoming_revision > existing_revision
                                || (incoming_revision == existing_revision
                                    && incoming_title_actor_wins(
                                        existing_updated_by.as_deref(),
                                        incoming_updated_by.as_deref(),
                                    ))))
                }
                _ => canonical_title_is_placeholder(kind, &existing_session.title),
            },
        }
    };

    if !incoming_wins {
        copy_title_metadata(&mut next_metadata, &existing_metadata, kind);
        if explicit_session_title_source(&existing_metadata, kind).is_none() {
            let revision = if existing_source == "placeholder" {
                0
            } else {
                existing_revision.max(1)
            };
            next_metadata.insert(
                "sessionTitleSource".to_string(),
                Value::String(existing_source.to_string()),
            );
            if kind != "group" {
                next_metadata.insert(
                    "titleSource".to_string(),
                    Value::String(existing_source.to_string()),
                );
            }
            next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
            next_metadata.insert(
                "sessionTitlePolicyVersion".to_string(),
                Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
            );
            next_metadata.insert(
                "sessionTitleUpdatedAtMs".to_string(),
                Value::from(existing_session.updated_at_ms),
            );
        }
        return (
            existing_session.title.clone(),
            Some(Value::Object(next_metadata)),
        );
    }

    let revision = if incoming_source == "placeholder" {
        0
    } else {
        incoming_revision.max(1)
    };
    next_metadata.insert(
        "sessionTitleSource".to_string(),
        Value::String(incoming_source.to_string()),
    );
    if kind != "group" {
        next_metadata.insert(
            "titleSource".to_string(),
            Value::String(incoming_source.to_string()),
        );
    }
    next_metadata.insert("sessionTitleRevision".to_string(), Value::from(revision));
    next_metadata.insert(
        "sessionTitlePolicyVersion".to_string(),
        Value::from(kordi_session::naming::SESSION_TITLE_POLICY_VERSION),
    );
    next_metadata
        .entry("sessionTitleUpdatedAtMs".to_string())
        .or_insert_with(|| Value::from(now_ms()));
    (incoming_title, Some(Value::Object(next_metadata)))
}
