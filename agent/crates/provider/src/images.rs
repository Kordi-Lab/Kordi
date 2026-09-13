//! Validate message image inputs before any provider can silently drop them.

use base64::Engine;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageRoute {
    OpenAi,
    Anthropic,
    Google,
}

pub(crate) fn validate_message_images(messages: &[Value], route: ImageRoute) -> KordiResult<()> {
    for (message_index, message) in messages.iter().enumerate() {
        if !matches!(message["role"].as_str(), Some("user" | "tool")) {
            continue;
        }
        let Some(blocks) = message["content"].as_array() else {
            continue;
        };
        for (block_index, block) in blocks.iter().enumerate() {
            let result = match block["type"].as_str() {
                Some("image") => validate_source(&block["source"], route)
                    .and_then(|()| validate_detail(block.get("detail"))),
                Some("image_url") if route == ImageRoute::OpenAi => {
                    validate_image_url(&block["image_url"])
                }
                Some("image_url" | "input_image") => Err(
                    "this image representation is unsupported on the selected route; attach a base64 image instead",
                ),
                Some("tool_result") => {
                    validate_message_images(
                        &[json!({"role":"tool","content":block["content"]})],
                        route,
                    )?;
                    continue;
                }
                _ => continue,
            };
            result.map_err(|reason| {
                KordiError::Provider(format!(
                    "Cannot send image in message {}, content block {}: {reason}.",
                    message_index + 1,
                    block_index + 1,
                ))
            })?;
        }
    }
    Ok(())
}

fn validate_source(source: &Value, route: ImageRoute) -> Result<(), &'static str> {
    // Anthropic already accepts URL sources; do not regress that existing path.
    if route == ImageRoute::Anthropic && source["type"] == "url" {
        return validate_remote_url(source["url"].as_str().unwrap_or(""));
    }
    if source["type"].as_str() != Some("base64") {
        return Err("an image must have a base64 source; reattach the image");
    }
    validate_base64_image(
        source["media_type"].as_str().unwrap_or(""),
        source["data"].as_str().unwrap_or(""),
        route,
    )
}

fn validate_base64_image(mime: &str, data: &str, route: ImageRoute) -> Result<(), &'static str> {
    // Gemini supports additional image MIME types. Let that provider validate
    // its format/model matrix instead of imposing OpenAI's narrower allowlist.
    let supported = if route == ImageRoute::Google {
        mime.starts_with("image/") && mime.len() > "image/".len()
    } else {
        matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    };
    if !supported {
        return Err("unsupported image format; use PNG, JPEG, WebP, or GIF");
    }
    if data.is_empty()
        || base64::engine::general_purpose::STANDARD
            .decode(data)
            .is_err()
    {
        return Err("image data is missing or invalid base64; reattach the image");
    }
    Ok(())
}

fn validate_detail(detail: Option<&Value>) -> Result<(), &'static str> {
    match detail {
        None => Ok(()),
        Some(value) if matches!(value.as_str(), Some("auto" | "low" | "high" | "original")) => {
            Ok(())
        }
        _ => Err(
            "unsupported image detail; use auto, low, high, or original where the model supports it",
        ),
    }
}

fn validate_image_url(image_url: &Value) -> Result<(), &'static str> {
    validate_detail(image_url.get("detail"))?;
    let url = image_url["url"].as_str().unwrap_or("");
    if let Some(data_url) = url.strip_prefix("data:") {
        let (mime, data) = data_url
            .split_once(";base64,")
            .ok_or("image data URLs must use base64 encoding")?;
        return validate_base64_image(mime, data, ImageRoute::OpenAi);
    }
    validate_remote_url(url)
}

fn validate_remote_url(url: &str) -> Result<(), &'static str> {
    match reqwest::Url::parse(url) {
        Ok(parsed)
            if matches!(parsed.scheme(), "https" | "http") && parsed.host_str().is_some() =>
        {
            Ok(())
        }
        _ => Err("image URL is missing or unsupported; use an HTTP(S) URL or base64 data URL"),
    }
}

/// OpenAI Responses and Codex accept the same image content block. Accept both
/// the internal representation and the Chat Completions intermediate format.
pub(crate) fn responses_image(block: &Value) -> Value {
    let (url, detail) = if block["type"] == "image_url" {
        (
            block["image_url"]["url"].clone(),
            block["image_url"].get("detail"),
        )
    } else {
        (
            json!(format!(
                "data:{};base64,{}",
                block["source"]["media_type"]
                    .as_str()
                    .unwrap_or("image/png"),
                block["source"]["data"].as_str().unwrap_or(""),
            )),
            block.get("detail"),
        )
    };
    json!({"type": "input_image", "image_url": url, "detail": detail.cloned().unwrap_or(json!("high"))})
}
