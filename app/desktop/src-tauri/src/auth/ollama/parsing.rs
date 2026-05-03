use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{
    DesktopOllamaCatalogModel, DesktopOllamaCatalogVariant, DesktopOllamaInstalledModel,
    OLLAMA_LIBRARY_URL,
};

const MAX_CATALOG_FAMILIES: usize = 120;
const MAX_CATALOG_VARIANTS: usize = 160;

pub(super) fn collect_ollama_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_ollama_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            if is_ollama_chat_model_object(object) {
                if let Some(id) = string_field(object, &["model", "name", "id"]) {
                    let id = canonical_ollama_model_id(&id);
                    if is_safe_model_id(&id) && !ids.iter().any(|existing| existing == &id) {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_ollama_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn collect_installed_models(
    value: &Value,
    models: &mut Vec<DesktopOllamaInstalledModel>,
) {
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

pub(super) fn filter_running_model_ids_to_installed(
    mut running_ids: Vec<String>,
    installed_models: &[DesktopOllamaInstalledModel],
) -> Vec<String> {
    let installed_ids = installed_models
        .iter()
        .map(|model| canonical_ollama_model_id(&model.id))
        .collect::<HashSet<_>>();
    running_ids.retain(|id| installed_ids.contains(&canonical_ollama_model_id(id)));
    running_ids.sort_by_key(|id| id.to_lowercase());
    running_ids.dedup();
    running_ids
}

fn installed_model_from_object(object: &Map<String, Value>) -> Option<DesktopOllamaInstalledModel> {
    if !is_ollama_chat_model_object(object) {
        return None;
    }
    let id =
        string_field(object, &["model", "name", "id"]).map(|id| canonical_ollama_model_id(&id))?;
    if !is_safe_model_id(&id) {
        return None;
    }
    let details = object.get("details").and_then(|value| value.as_object());
    Some(DesktopOllamaInstalledModel {
        name: id.clone(),
        id,
        size: size_field(object),
        family: details.and_then(|details| string_field(details, &["family"])),
        parameter_size: details.and_then(|details| string_field(details, &["parameter_size"])),
        quantization: details.and_then(|details| string_field(details, &["quantization_level"])),
        modified_at: string_field(object, &["modified_at"]),
    })
}

fn is_ollama_chat_model_object(object: &Map<String, Value>) -> bool {
    let id = string_field(object, &["model", "name", "id"]).unwrap_or_default();
    if is_embedding_model_id(&id) {
        return false;
    }

    let Some(details) = object.get("details").and_then(|value| value.as_object()) else {
        return true;
    };
    if string_field(details, &["family"])
        .as_deref()
        .is_some_and(is_embedding_family)
    {
        return false;
    }
    details
        .get("families")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .all(|family| !is_embedding_family(family))
}

fn is_embedding_family(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.contains("embed") || lower.contains("embedding") || lower == "bert"
}

pub(super) fn is_embedding_model_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    let model_part = lower
        .rsplit_once('/')
        .map(|(_, suffix)| suffix)
        .unwrap_or(&lower);
    model_part.contains("embedding")
        || model_part.contains("embed-text")
        || model_part.contains("-embed")
        || model_part.starts_with("text-embedding")
        || model_part.starts_with("embed-")
        || model_part.starts_with("nomic-embed")
        || model_part.starts_with("mxbai-embed")
        || model_part.starts_with("all-minilm")
        || model_part.starts_with("bge-")
        || model_part.starts_with("bge_")
        || model_part.starts_with("paraphrase-")
        || model_part.starts_with("snowflake-arctic-embed")
}

pub(super) fn sanitize_chat_model_arg(value: &str) -> Result<String, String> {
    let model = sanitize_model_arg(value)?;
    if is_embedding_model_id(&model) {
        return Err(format!(
            "`{model}` is an embedding model and cannot be used for chat. Choose a chat model instead."
        ));
    }
    Ok(model)
}

pub(super) fn sanitize_model_arg(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a model before running this action.".to_string());
    }
    if !is_safe_model_id(trimmed) {
        return Err(
            "Model names may only contain letters, numbers, '.', '-', '_', '/', and ':'."
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn is_safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 220
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':'))
}

pub(super) fn canonical_ollama_model_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:latest")
    }
}

pub(super) fn parse_ollama_catalog_models(html: &str) -> Vec<DesktopOllamaCatalogModel> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for block in html.split("<li x-test-model").skip(1) {
        let block = block
            .split_once("</li>")
            .map(|(item, _)| item)
            .unwrap_or(block);
        let Some(href) = attr_after(block, "href=\"/library/") else {
            continue;
        };
        let id = href
            .split(['\"', '?', '#'])
            .next()
            .unwrap_or_default()
            .trim();
        if id.is_empty()
            || id.contains(':')
            || is_embedding_model_id(id)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        let title = attr_after(block, "title=\"")
            .and_then(|value| value.split('\"').next().map(html_text))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| id.to_string());
        let description = first_paragraph_text(block);
        let sizes = collect_badge_values(block, "x-test-size");
        let pulls = test_value(block, "x-test-pull-count");
        let tags = test_value(block, "x-test-tag-count");
        models.push(DesktopOllamaCatalogModel {
            id: id.to_string(),
            name: title,
            url: format!("{OLLAMA_LIBRARY_URL}/{id}"),
            description,
            sizes,
            pulls,
            tags,
            variants: Vec::new(),
        });
        if models.len() >= MAX_CATALOG_FAMILIES {
            break;
        }
    }
    models
}

pub(super) fn parse_ollama_catalog_variants(
    family: &str,
    html: &str,
) -> Vec<DesktopOllamaCatalogVariant> {
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    let marker = "<input class=\"command hidden\" value=\"";
    for part in html.split(marker).skip(1) {
        let Some(id) = part.split('\"').next().map(str::trim) else {
            continue;
        };
        if id.is_empty()
            || !id.starts_with(family)
            || is_embedding_model_id(id)
            || !is_safe_model_id(id)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        let row = part.split(marker).next().unwrap_or(part);
        let text = html_text(row);
        variants.push(DesktopOllamaCatalogVariant {
            id: id.to_string(),
            name: id.to_string(),
            url: format!("{OLLAMA_LIBRARY_URL}/{id}"),
            size: first_size_text(&text),
            context: first_context_text(&text),
            input: first_input_text(&text),
        });
        if variants.len() >= MAX_CATALOG_VARIANTS {
            break;
        }
    }
    variants
}

fn attr_after<'a>(value: &'a str, marker: &str) -> Option<&'a str> {
    value.split_once(marker).map(|(_, tail)| tail)
}

fn first_paragraph_text(block: &str) -> Option<String> {
    let tail = block.split_once("<p")?.1;
    let content = tail.split_once('>')?.1;
    let value = html_text(
        content
            .split_once("</p>")
            .map(|(text, _)| text)
            .unwrap_or(content),
    );
    (!value.is_empty()).then_some(value)
}

fn collect_badge_values(block: &str, marker: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    for part in block.split(marker).skip(1) {
        let Some(content) = part.split_once('>').map(|(_, tail)| tail) else {
            continue;
        };
        let value = html_text(
            content
                .split_once('<')
                .map(|(text, _)| text)
                .unwrap_or(content),
        );
        if !value.is_empty() && seen.insert(value.clone()) {
            values.push(value);
        }
    }
    values
}

fn test_value(block: &str, marker: &str) -> Option<String> {
    let content = block.split_once(marker)?.1.split_once('>')?.1;
    let value = html_text(
        content
            .split_once('<')
            .map(|(text, _)| text)
            .unwrap_or(content),
    );
    (!value.is_empty()).then_some(value)
}

fn first_size_text(value: &str) -> Option<String> {
    first_token_with_suffix(value, &["GB", "MB", "KB"])
}

fn first_context_text(value: &str) -> Option<String> {
    value.split('•').find_map(|part| {
        let cleaned = part.trim();
        cleaned
            .to_ascii_lowercase()
            .contains("context")
            .then(|| cleaned.to_string())
    })
}

fn first_input_text(value: &str) -> Option<String> {
    value.split('•').find_map(|part| {
        let cleaned = part.trim();
        cleaned
            .to_ascii_lowercase()
            .contains("input")
            .then(|| cleaned.to_string())
    })
}

fn first_token_with_suffix(value: &str, suffixes: &[&str]) -> Option<String> {
    let tokens = value.split_whitespace().collect::<Vec<_>>();
    for token in &tokens {
        for suffix in suffixes {
            if token.len() > suffix.len() && token.to_ascii_uppercase().ends_with(suffix) {
                let number = &token[..token.len() - suffix.len()];
                if number.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
                    return Some(format!("{number}{suffix}"));
                }
            }
        }
    }
    for pair in tokens.windows(2) {
        if suffixes
            .iter()
            .any(|suffix| pair[1].eq_ignore_ascii_case(suffix))
            && pair[0].chars().all(|ch| ch.is_ascii_digit() || ch == '.')
        {
            return Some(format!("{}{}", pair[0], pair[1]));
        }
    }
    None
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        let value = value.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn size_field(object: &Map<String, Value>) -> Option<String> {
    if let Some(value) = string_field(object, &["size", "fileSize", "file_size", "modelSize"]) {
        return Some(value);
    }
    [
        "size",
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

pub(super) fn html_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;
    let mut entity = String::new();
    let mut in_entity = false;

    for ch in value.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
                output.push(' ');
            }
            continue;
        }
        if ch == '<' {
            in_tag = true;
            output.push(' ');
            continue;
        }
        if in_entity {
            if ch == ';' {
                output.push(match entity.as_str() {
                    "amp" => '&',
                    "quot" => '"',
                    "#39" | "apos" => '\'',
                    "lt" => '<',
                    "gt" => '>',
                    "nbsp" => ' ',
                    _ => ' ',
                });
                entity.clear();
                in_entity = false;
            } else if entity.len() < 12 {
                entity.push(ch);
            } else {
                entity.clear();
                in_entity = false;
            }
            continue;
        }
        if ch == '&' {
            in_entity = true;
            entity.clear();
            continue;
        }
        output.push(ch);
    }

    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_ollama_model_id_adds_latest_when_missing_tag() {
        assert_eq!(canonical_ollama_model_id("llama3.2"), "llama3.2:latest");
    }

    fn installed_model(id: &str) -> DesktopOllamaInstalledModel {
        DesktopOllamaInstalledModel {
            id: id.to_string(),
            name: id.to_string(),
            size: None,
            family: None,
            parameter_size: None,
            quantization: None,
            modified_at: None,
        }
    }

    #[test]
    fn running_model_filter_excludes_deleted_stale_runtime_entries() {
        let ids = filter_running_model_ids_to_installed(
            vec!["qwen:1.8b-chat".to_string(), "qwen3:0.6b-fp16".to_string()],
            &[installed_model("qwen3:0.6b-fp16")],
        );

        assert_eq!(ids, vec!["qwen3:0.6b-fp16"]);
    }

    #[test]
    fn running_model_filter_matches_implicit_latest_installed_models() {
        let ids = filter_running_model_ids_to_installed(
            vec!["llama3.2".to_string()],
            &[installed_model("llama3.2:latest")],
        );

        assert_eq!(ids, vec!["llama3.2"]);
    }

    #[test]
    fn installed_model_parser_excludes_embedding_models() {
        let value = json!({
            "models": [
                {"name": "llama3.2:latest", "model": "llama3.2:latest", "size": 2019393189, "details": {"family": "llama"}},
                {"name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest", "size": 274000000, "details": {"family": "bert"}}
            ]
        });
        let mut models = Vec::new();
        collect_installed_models(&value, &mut models);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "llama3.2:latest");
    }

    #[test]
    fn running_model_parser_canonicalizes_and_excludes_embeddings() {
        let value = json!({
            "models": [
                {"name": "gemma3", "model": "gemma3", "details": {"family": "gemma"}},
                {"name": "all-minilm:latest", "model": "all-minilm:latest", "details": {"family": "bert"}}
            ]
        });
        let mut ids = Vec::new();
        collect_ollama_model_ids(&value, &mut ids);
        assert_eq!(ids, vec!["gemma3:latest"]);
    }

    #[test]
    fn catalog_parser_skips_embedding_families() {
        let html = r#"
          <li x-test-model><a href="/library/llama3.2"><div x-test-model-title title="llama3.2"><p>Small model.</p><span x-test-size>3b</span></div><span x-test-pull-count>1M</span><span x-test-tag-count>8</span></a></li>
          <li x-test-model><a href="/library/nomic-embed-text"><div x-test-model-title title="nomic-embed-text"><p>Embedding model.</p></div></a></li>
        "#;
        let models = parse_ollama_catalog_models(html);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "llama3.2");
        assert_eq!(models[0].sizes, vec!["3b"]);
    }

    #[test]
    fn tag_parser_extracts_exact_variants() {
        let html = r#"
          <input class="command hidden" value="llama3.2:latest" />
          <p>2.0GB · 128K context window · Text input · 1 year ago</p>
          <input class="command hidden" value="llama3.2:3b" />
          <p>2.0GB · 128K context window · Text input · 1 year ago</p>
        "#;
        let variants = parse_ollama_catalog_variants("llama3.2", html);
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].id, "llama3.2:latest");
        assert_eq!(variants[0].size.as_deref(), Some("2.0GB"));
    }
}
