use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{
    DesktopLmStudioCatalogModel, DesktopLmStudioCatalogVariant, DesktopLmStudioInstalledModel,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LmStudioLoadedModelInstance {
    pub(super) model_id: String,
    pub(super) identifier: String,
    pub(super) context_length: Option<u64>,
    pub(super) max_context_length: Option<u64>,
}

pub(super) fn parse_catalog_models(html: &str) -> Vec<DesktopLmStudioCatalogModel> {
    let mut models: Vec<DesktopLmStudioCatalogModel> = Vec::new();
    let mut rest = html;

    while let Some(href_index) = rest.find("href=\"/models/") {
        rest = &rest[href_index + "href=\"".len()..];
        let Some(href_end) = rest.find('"') else {
            break;
        };
        let href = &rest[..href_end];
        let id = href.trim_start_matches("/models/").trim_matches('/');
        if id.is_empty() || id.contains('/') || models.iter().any(|model| model.id == id) {
            rest = &rest[href_end..];
            continue;
        }

        let block = rest[..rest.find("</a>").unwrap_or(rest.len())].to_string();
        let name = extract_after(&block, "class=\"text-lg font-medium\">", "</div>")
            .map(|value| html_text(&value))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.to_string());
        let sizes = extract_model_sizes(&block);
        let updated = extract_updated(&block);

        models.push(DesktopLmStudioCatalogModel {
            id: id.to_string(),
            name,
            url: format!("https://lmstudio.ai{href}"),
            sizes,
            updated,
            variants: Vec::new(),
        });
        rest = &rest[href_end..];
    }

    models.sort_by_key(|model| model.name.to_lowercase());
    models
}

pub(super) fn parse_catalog_variants(html: &str) -> Vec<DesktopLmStudioCatalogVariant> {
    let mut variants: Vec<DesktopLmStudioCatalogVariant> = Vec::new();
    let mut rest = html;
    let href_marker = "href=\"/models/";

    while let Some(href_index) = rest.find(href_marker) {
        let candidate_start = href_index + "href=\"".len();
        rest = &rest[candidate_start..];
        let Some(href_end) = rest.find('"') else {
            break;
        };
        let href = &rest[..href_end];
        let id = href.trim_start_matches("/models/").trim_matches('/');
        if !id.contains('/') || variants.iter().any(|variant| variant.id == id) {
            rest = &rest[href_end..];
            continue;
        }

        let next_href = rest[href_end..]
            .find(href_marker)
            .map(|index| href_end + index)
            .unwrap_or(rest.len());
        let row = &rest[..next_href];
        let size = extract_after(row, "data-state=\"closed\">", "</div>")
            .map(|value| html_text(&value))
            .filter(|value| !value.is_empty());

        variants.push(DesktopLmStudioCatalogVariant {
            id: id.to_string(),
            name: id.to_string(),
            url: format!("https://lmstudio.ai{href}"),
            size,
        });
        rest = &rest[href_end..];
    }

    variants.sort_by_key(|variant| variant.name.to_lowercase());
    variants
}

fn extract_after(value: &str, start: &str, end: &str) -> Option<String> {
    let start_index = value.find(start)? + start.len();
    let tail = &value[start_index..];
    let end_index = tail.find(end)?;
    Some(tail[..end_index].to_string())
}

fn extract_model_sizes(block: &str) -> Vec<String> {
    let mut sizes = Vec::new();
    let mut rest = block;
    let marker = "title=\"Model size: ";

    while let Some(index) = rest.find(marker) {
        rest = &rest[index + marker.len()..];
        let Some(end) = rest.find(" parameters") else {
            continue;
        };
        let size = html_text(&rest[..end]);
        if !size.is_empty() && !sizes.iter().any(|existing| existing == &size) {
            sizes.push(size);
        }
    }

    sizes
}

fn extract_updated(block: &str) -> Option<String> {
    let marker = "Updated <!-- -->";
    let start = block.find(marker)? + marker.len();
    let tail = &block[start..];
    let end = tail.find("</div>").unwrap_or(tail.len());
    let updated = html_text(&tail[..end]);
    (!updated.is_empty()).then(|| format!("Updated {updated}"))
}

pub(super) fn html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split('<')
        .map(|part| part.split('>').next_back().unwrap_or(part))
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn parse_installed_models(
    raw: &str,
) -> Result<Vec<DesktopLmStudioInstalledModel>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ls --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut models = Vec::new();
    collect_installed_models(&json, &mut models);

    let mut by_id: HashMap<String, DesktopLmStudioInstalledModel> = HashMap::new();
    for model in models {
        by_id.entry(model.id.clone()).or_insert(model);
    }
    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by_key(|model| model.id.to_lowercase());
    Ok(models)
}

pub(super) fn parse_model_ids(raw: &str) -> Result<Vec<String>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ps --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut ids = Vec::new();
    collect_model_ids(&json, &mut ids);
    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();
    Ok(ids)
}

pub(super) fn parse_loaded_model_instances(
    raw: &str,
) -> Result<Vec<LmStudioLoadedModelInstance>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ps --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut instances = Vec::new();
    collect_loaded_model_instances(&json, &mut instances);
    instances.sort_by(|left, right| left.identifier.cmp(&right.identifier));
    instances.dedup_by(|left, right| left.identifier == right.identifier);
    Ok(instances)
}

fn collect_installed_models(value: &Value, models: &mut Vec<DesktopLmStudioInstalledModel>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_installed_models(item, models);
            }
        }
        Value::Object(object) => {
            if let Some(model) = installed_model_from_object(object) {
                models.push(model);
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_installed_models(value, models);
                }
            }
        }
        _ => {}
    }
}

fn collect_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            if is_lm_studio_chat_model_object(object) {
                if let Some(id) = string_field(
                    object,
                    &[
                        "modelKey",
                        "model_key",
                        "indexedModelIdentifier",
                        "path",
                        "key",
                        "id",
                        "model",
                        "identifier",
                    ],
                ) {
                    let id = canonical_lm_studio_model_id(id.trim());
                    if is_safe_model_id(&id)
                        && !is_lm_studio_embedding_model_id(&id)
                        && !ids.iter().any(|existing| existing == &id)
                    {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn collect_rest_loaded_llm_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_rest_loaded_llm_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            let has_loaded_instances = object
                .get("loaded_instances")
                .and_then(|value| value.as_array())
                .is_some_and(|instances| !instances.is_empty());
            if is_lm_studio_chat_model_object(object) && has_loaded_instances {
                if let Some(id) = string_field(
                    object,
                    &[
                        "key",
                        "modelKey",
                        "model_key",
                        "indexedModelIdentifier",
                        "path",
                        "id",
                        "model",
                    ],
                ) {
                    let id = canonical_lm_studio_model_id(id.trim());
                    if is_safe_model_id(&id)
                        && !is_lm_studio_embedding_model_id(&id)
                        && !ids.iter().any(|existing| existing == &id)
                    {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_rest_loaded_llm_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

fn collect_loaded_model_instances(value: &Value, instances: &mut Vec<LmStudioLoadedModelInstance>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_loaded_model_instances(item, instances);
            }
        }
        Value::Object(object) => {
            if let Some(instance) = loaded_model_instance_from_object(object) {
                instances.push(instance);
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_loaded_model_instances(value, instances);
                }
            }
        }
        _ => {}
    }
}

fn loaded_model_instance_from_object(
    object: &Map<String, Value>,
) -> Option<LmStudioLoadedModelInstance> {
    if !is_lm_studio_chat_model_object(object) {
        return None;
    }

    let model_id = string_field(
        object,
        &[
            "modelKey",
            "model_key",
            "indexedModelIdentifier",
            "path",
            "key",
            "model",
        ],
    )?;
    let identifier =
        string_field(object, &["identifier", "id"]).unwrap_or_else(|| model_id.clone());
    let model_id = lm_studio_model_match_key(&model_id);
    if !is_safe_model_id(&model_id) || !is_safe_model_id(&identifier) {
        return None;
    }

    Some(LmStudioLoadedModelInstance {
        model_id,
        identifier,
        context_length: context_length_field(object),
        max_context_length: max_context_length_field(object),
    })
}

pub(super) fn model_max_context_length_from_value(value: &Value, model: &str) -> Option<u64> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| model_max_context_length_from_value(item, model))
            .max(),
        Value::Object(object) => {
            let current = object_matches_lm_studio_model(object, model)
                .then(|| max_context_length_field(object))
                .flatten();
            let nested = object
                .values()
                .filter(|value| matches!(value, Value::Array(_) | Value::Object(_)))
                .filter_map(|value| model_max_context_length_from_value(value, model))
                .max();
            current.or(nested)
        }
        _ => None,
    }
}

fn object_matches_lm_studio_model(object: &Map<String, Value>, model: &str) -> bool {
    if !is_lm_studio_chat_model_object(object) {
        return false;
    }

    for key in [
        "modelKey",
        "model_key",
        "indexedModelIdentifier",
        "path",
        "key",
        "id",
        "model",
        "identifier",
        "selectedVariant",
        "selected_variant",
    ] {
        if object
            .get(key)
            .and_then(|value| value.as_str())
            .is_some_and(|value| lm_studio_model_ids_match(value, model))
        {
            return true;
        }
    }

    object
        .get("variants")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .any(|value| lm_studio_model_ids_match(value, model))
}

fn installed_model_from_object(
    object: &Map<String, Value>,
) -> Option<DesktopLmStudioInstalledModel> {
    if !is_lm_studio_chat_model_object(object) {
        return None;
    }

    let id = string_field(
        object,
        &[
            "modelKey",
            "model_key",
            "key",
            "id",
            "identifier",
            "model",
            "name",
        ],
    )?;
    let id = id.trim();
    if !is_safe_model_id(id) {
        return None;
    }

    Some(DesktopLmStudioInstalledModel {
        id: id.to_string(),
        name: string_field(object, &["displayName", "display_name", "name", "label"])
            .unwrap_or_else(|| id.to_string()),
        size: size_field(object),
        path: string_field(
            object,
            &["path", "modelPath", "model_path", "filePath", "file_path"],
        ),
        architecture: string_field(
            object,
            &["architecture", "arch", "modelArchitecture", "type"],
        ),
    })
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        let value = value.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn is_lm_studio_chat_model_object(object: &Map<String, Value>) -> bool {
    object
        .get("type")
        .and_then(|value| value.as_str())
        .is_none_or(|kind| !kind.eq_ignore_ascii_case("embedding"))
}

pub(super) fn is_lm_studio_embedding_model_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.contains("embedding")
        || lower.contains("embed-text")
        || lower.starts_with("text-embedding")
        || lower.starts_with("embed-")
        || lower.starts_with("nomic-embed")
}

fn u64_field(object: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
    })
}

fn context_length_field(object: &Map<String, Value>) -> Option<u64> {
    u64_field(object, &["contextLength", "context_length", "n_ctx"]).or_else(|| {
        object
            .get("config")?
            .as_object()
            .and_then(context_length_field)
    })
}

fn max_context_length_field(object: &Map<String, Value>) -> Option<u64> {
    u64_field(
        object,
        &[
            "maxContextLength",
            "max_context_length",
            "max_context",
            "maxContextTokens",
            "max_context_tokens",
        ],
    )
}

fn size_field(object: &Map<String, Value>) -> Option<String> {
    if let Some(value) = string_field(object, &["size", "fileSize", "file_size", "modelSize"]) {
        return Some(value);
    }

    [
        "sizeBytes",
        "size_bytes",
        "fileSizeBytes",
        "file_size_bytes",
    ]
    .iter()
    .find_map(|key| object.get(*key)?.as_u64())
    .map(format_bytes)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

pub(super) fn canonical_lm_studio_model_id(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((base, suffix)) = trimmed.rsplit_once(':') {
        if base.contains('/') && suffix.chars().all(|ch| ch.is_ascii_digit()) {
            return base.to_string();
        }
    }
    trimmed.to_string()
}

pub(super) fn lm_studio_model_match_key(value: &str) -> String {
    let canonical = canonical_lm_studio_model_id(value);
    canonical
        .split_once('@')
        .map(|(base, _)| base)
        .unwrap_or(canonical.as_str())
        .to_string()
}

pub(super) fn lm_studio_model_ids_match(left: &str, right: &str) -> bool {
    lm_studio_model_match_key(left) == lm_studio_model_match_key(right)
}

pub(super) fn is_safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 220
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '@'))
}

pub(super) fn sanitize_model_arg(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a model before running this action.".to_string());
    }
    if trimmed.len() > 220 {
        return Err("Model id is too long.".to_string());
    }
    if !is_safe_model_id(trimmed) {
        return Err("Model ids can only contain letters, numbers, slash, colon, dot, dash, underscore, or @.".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lms_ps_parser_prefers_canonical_model_key_over_runtime_identifier() {
        let raw = r#"[
          {
            "modelKey": "google/gemma-4-e4b",
            "indexedModelIdentifier": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b:6",
            "selectedVariant": "google/gemma-4-e4b@q4_k_m"
          }
        ]"#;

        assert_eq!(parse_model_ids(raw).unwrap(), vec!["google/gemma-4-e4b"]);
    }

    #[test]
    fn embedding_models_are_excluded_from_chat_model_ids() {
        let raw = r#"[
          {
            "type": "llm",
            "modelKey": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b"
          },
          {
            "type": "embedding",
            "modelKey": "text-embedding-nomic-embed-text-v1.5",
            "identifier": "text-embedding-nomic-embed-text-v1.5"
          }
        ]"#;

        assert_eq!(parse_model_ids(raw).unwrap(), vec!["google/gemma-4-e4b"]);
        assert_eq!(parse_loaded_model_instances(raw).unwrap().len(), 1);
        assert_eq!(parse_installed_models(raw).unwrap().len(), 1);
        assert!(is_lm_studio_embedding_model_id(
            "text-embedding-nomic-embed-text-v1.5"
        ));
    }

    #[test]
    fn rest_loaded_model_parser_keeps_only_loaded_llms() {
        let json = json!({
            "models": [
                {
                    "type": "llm",
                    "key": "google/gemma-4-e4b",
                    "loaded_instances": [{"id": "google/gemma-4-e4b", "config": {"context_length": 131072}}]
                },
                {
                    "type": "embedding",
                    "key": "text-embedding-nomic-embed-text-v1.5",
                    "loaded_instances": [{"id": "text-embedding-nomic-embed-text-v1.5"}]
                },
                {
                    "type": "llm",
                    "key": "qwen/qwen3",
                    "loaded_instances": []
                }
            ]
        });
        let mut ids = Vec::new();
        collect_rest_loaded_llm_model_ids(&json, &mut ids);

        assert_eq!(ids, vec!["google/gemma-4-e4b"]);
    }

    #[test]
    fn lms_ps_parser_captures_context_lengths_for_reload_decisions() {
        let raw = r#"[
          {
            "modelKey": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b",
            "maxContextLength": 131072,
            "contextLength": 4096
          }
        ]"#;

        let instances = parse_loaded_model_instances(raw).unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].model_id, "google/gemma-4-e4b");
        assert_eq!(instances[0].identifier, "google/gemma-4-e4b");
        assert_eq!(instances[0].context_length, Some(4096));
        assert_eq!(instances[0].max_context_length, Some(131072));
    }

    #[test]
    fn installed_model_max_context_matches_base_and_variant_ids() {
        let json = json!([
            {
                "modelKey": "google/gemma-4-e4b",
                "selectedVariant": "google/gemma-4-e4b@q4_k_m",
                "maxContextLength": 131072
            }
        ]);

        assert_eq!(
            model_max_context_length_from_value(&json, "google/gemma-4-e4b"),
            Some(131072)
        );
        assert_eq!(
            model_max_context_length_from_value(&json, "google/gemma-4-e4b@q4_k_m"),
            Some(131072)
        );
    }

    #[test]
    fn lm_studio_model_matching_ignores_runtime_suffix_and_variant_suffix() {
        assert!(lm_studio_model_ids_match(
            "google/gemma-4-e4b:6",
            "google/gemma-4-e4b@q4_k_m"
        ));
    }

    #[test]
    fn canonical_lm_studio_model_id_strips_numeric_runtime_suffix() {
        assert_eq!(
            canonical_lm_studio_model_id("google/gemma-4-e4b:6"),
            "google/gemma-4-e4b"
        );
        assert_eq!(
            canonical_lm_studio_model_id("google/gemma-4-e4b@q4_k_m"),
            "google/gemma-4-e4b@q4_k_m"
        );
    }
}
