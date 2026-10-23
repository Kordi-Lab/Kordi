//! Memory categories, declaration types and profile routing (#1977).
//!
//! Every memory carries one HCP category that says what kind of information
//! it is. The category decides which Grounding profile kind the memory is
//! filed to by default; an explicit `profile_id` the person chose wins.
//! Group memories describe the group, so they never route to a profile and
//! may not use the categories that describe one person.

use axum::http::StatusCode;

use super::{MemoryError, MemoryResult, SaveMemoryRequest};

pub(crate) const MEMORY_CATEGORIES: [&str; 10] = [
    "general_preferences",
    "goals_and_constraints",
    "health_context",
    "education_learner_profile",
    "work_context",
    "purchase_history_preferences",
    "values_and_ethics",
    "location_context",
    "coordination_context",
    "hcp-custom:task_lessons",
];
/// The category of a memory saved without one.
pub(crate) const DEFAULT_CATEGORY: &str = "general_preferences";
pub(crate) const MEMORY_CONFIDENCES: [&str; 3] = ["low", "medium", "high"];
/// The confidence of an inferred memory saved without one.
pub(crate) const DEFAULT_CONFIDENCE: &str = "medium";
pub(crate) const USER_DECLARED: &str = "user-declared";
pub(crate) const MODEL_INFERRED: &str = "model-inferred";

/// The profile kind a category routes to by default: `all` means every
/// fixed-kind profile; `None` means the memory stays prompt-only.
pub(crate) fn profile_kind_for(category: &str) -> Option<&'static str> {
    match category {
        "work_context" | "education_learner_profile" => Some("work"),
        "health_context" => Some("health"),
        "location_context" | "purchase_history_preferences" => Some("daily"),
        "coordination_context" => Some("all"),
        _ => None,
    }
}

/// Whether a group memory may use the category. Health, location, purchases
/// and values describe one person, not a group.
pub(crate) fn category_allowed_in_group(category: &str) -> bool {
    !matches!(
        category,
        "health_context"
            | "location_context"
            | "purchase_history_preferences"
            | "values_and_ethics"
    )
}

/// The profile kind a memory is effectively filed to: the explicit
/// profile's kind when the person chose one, else the category's default.
/// Group memories are never filed to a profile.
pub(crate) fn effective_profile_kind(
    scope: &str,
    category: &str,
    explicit_kind: Option<String>,
) -> Option<String> {
    if scope == "group" {
        return None;
    }
    explicit_kind.or_else(|| profile_kind_for(category).map(str::to_owned))
}

pub(crate) fn invalid_category() -> MemoryError {
    MemoryError::bad_request(
        "invalid_category",
        "category must be one of the memory categories.",
    )
}

pub(crate) fn invalid_confidence() -> MemoryError {
    MemoryError::bad_request(
        "invalid_confidence",
        "confidence must be low, medium, or high.",
    )
}

pub(crate) fn invalid_declared_by() -> MemoryError {
    MemoryError::bad_request("invalid_declared_by", "declaredBy must be user or agent.")
}

pub(crate) fn invalid_update() -> MemoryError {
    MemoryError::bad_request(
        "invalid_update",
        "Send at least one of text, category, or profileId.",
    )
}

pub(crate) fn category_not_shared() -> MemoryError {
    MemoryError::new(
        StatusCode::FORBIDDEN,
        "memory_category_not_shared",
        "This kind of memory describes one person and cannot be saved for a group.",
    )
}

pub(crate) fn profile_not_allowed() -> MemoryError {
    MemoryError::new(
        StatusCode::FORBIDDEN,
        "memory_profile_not_allowed",
        "Group memories cannot be filed to a profile.",
    )
}

pub(crate) fn profile_not_found() -> MemoryError {
    MemoryError::new(
        StatusCode::NOT_FOUND,
        "profile_not_found",
        "Profile was not found.",
    )
}

/// A checked category. Missing or empty uses the default when `default` is
/// true; an unknown value is refused.
pub(crate) fn check_category(value: Option<&str>, default: bool) -> MemoryResult<&'static str> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None if default => Ok(DEFAULT_CATEGORY),
        None => Err(invalid_category()),
        Some(value) => MEMORY_CATEGORIES
            .iter()
            .copied()
            .find(|category| *category == value)
            .ok_or_else(invalid_category),
    }
}

/// The checked category, declaration type and confidence of a save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SaveFields {
    pub category: &'static str,
    pub declaration_type: &'static str,
    pub confidence: Option<&'static str>,
}

/// Resolves the new fields of a save into `scope`. The declaration comes
/// from `declaredBy` when given, else from the source (`manual` is the
/// person's own). Inferred memories default to medium confidence; declared
/// ones carry none.
pub(crate) fn save_fields(input: &SaveMemoryRequest, scope: &str) -> MemoryResult<SaveFields> {
    let category = check_category(input.category.as_deref(), true)?;
    if scope == "group" && !category_allowed_in_group(category) {
        return Err(category_not_shared());
    }
    let declaration_type = match input.declared_by.as_deref().map(str::trim) {
        Some("user") => USER_DECLARED,
        Some("agent") => MODEL_INFERRED,
        Some(_) => return Err(invalid_declared_by()),
        None if input.source.trim() == "manual" => USER_DECLARED,
        None => MODEL_INFERRED,
    };
    let confidence = match input.confidence.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(
            MEMORY_CONFIDENCES
                .iter()
                .copied()
                .find(|confidence| *confidence == value)
                .ok_or_else(invalid_confidence)?,
        ),
    };
    let confidence = if declaration_type == MODEL_INFERRED {
        Some(confidence.unwrap_or(DEFAULT_CONFIDENCE))
    } else {
        None
    };
    Ok(SaveFields {
        category,
        declaration_type,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(source: &str) -> SaveMemoryRequest {
        SaveMemoryRequest {
            scope: "conversation".into(),
            scope_id: "s".into(),
            scope_label: None,
            source: source.into(),
            text: "t".into(),
            client_memory_id: None,
            category: None,
            confidence: None,
            declared_by: None,
        }
    }

    #[test]
    fn profile_kinds_follow_the_plan() {
        assert_eq!(profile_kind_for("work_context"), Some("work"));
        assert_eq!(profile_kind_for("education_learner_profile"), Some("work"));
        assert_eq!(profile_kind_for("health_context"), Some("health"));
        assert_eq!(profile_kind_for("location_context"), Some("daily"));
        assert_eq!(
            profile_kind_for("purchase_history_preferences"),
            Some("daily")
        );
        assert_eq!(profile_kind_for("coordination_context"), Some("all"));
        for category in [
            "general_preferences",
            "goals_and_constraints",
            "values_and_ethics",
            "hcp-custom:task_lessons",
        ] {
            assert_eq!(profile_kind_for(category), None, "{category}");
        }
        assert_eq!(effective_profile_kind("group", "work_context", None), None);
        assert_eq!(
            effective_profile_kind("global", "work_context", Some("custom".into())),
            Some("custom".into())
        );
    }

    #[test]
    fn group_categories_exclude_personal_ones() {
        let refused: Vec<_> = MEMORY_CATEGORIES
            .iter()
            .filter(|category| !category_allowed_in_group(category))
            .collect();
        assert_eq!(
            refused,
            [
                &"health_context",
                &"purchase_history_preferences",
                &"values_and_ethics",
                &"location_context"
            ]
        );
    }

    #[test]
    fn save_fields_derive_declaration_and_confidence() {
        let fields = save_fields(&request("manual"), "global").unwrap();
        assert_eq!(fields.category, DEFAULT_CATEGORY);
        assert_eq!(fields.declaration_type, USER_DECLARED);
        assert_eq!(fields.confidence, None);

        let mut agent = request("user_correction");
        agent.confidence = Some("high".into());
        agent.category = Some(" work_context ".into());
        let fields = save_fields(&agent, "conversation").unwrap();
        assert_eq!(fields.category, "work_context");
        assert_eq!(fields.declaration_type, MODEL_INFERRED);
        assert_eq!(fields.confidence, Some("high"));

        let mut declared = request("outcome");
        declared.declared_by = Some("user".into());
        declared.confidence = Some("low".into());
        let fields = save_fields(&declared, "conversation").unwrap();
        assert_eq!(fields.declaration_type, USER_DECLARED);
        assert_eq!(fields.confidence, None);

        let mut bad = request("manual");
        bad.category = Some("diary".into());
        assert_eq!(
            save_fields(&bad, "global").unwrap_err().code,
            "invalid_category"
        );
        let mut bad = request("manual");
        bad.confidence = Some("certain".into());
        assert_eq!(
            save_fields(&bad, "global").unwrap_err().code,
            "invalid_confidence"
        );
        let mut bad = request("manual");
        bad.declared_by = Some("robot".into());
        assert_eq!(
            save_fields(&bad, "global").unwrap_err().code,
            "invalid_declared_by"
        );
        let mut health = request("manual");
        health.category = Some("health_context".into());
        assert_eq!(
            save_fields(&health, "group").unwrap_err().code,
            "memory_category_not_shared"
        );
    }
}
