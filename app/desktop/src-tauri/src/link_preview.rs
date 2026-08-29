use std::{collections::HashMap, time::Duration};

use futures_util::{pin_mut, StreamExt};
use reqwest::{header::CONTENT_TYPE, Url};
use serde::Serialize;

use crate::remote_image::{request_public_remote_image, validated_remote_image_url};

const LINK_PREVIEW_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_LINK_PREVIEW_HTML_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLinkPreviewMetadata {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
    site_name: Option<String>,
}

fn supported_html_media_type(value: &str) -> bool {
    matches!(
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "text/html" | "application/xhtml+xml"
    )
}

fn decode_html_entity(value: &str) -> Option<char> {
    match value {
        "amp" => Some('&'),
        "apos" | "#39" => Some('\''),
        "gt" => Some('>'),
        "lt" => Some('<'),
        "nbsp" => Some(' '),
        "quot" => Some('"'),
        _ if value.starts_with("#x") || value.starts_with("#X") => {
            u32::from_str_radix(&value[2..], 16)
                .ok()
                .and_then(char::from_u32)
        }
        _ if value.starts_with('#') => value[1..].parse().ok().and_then(char::from_u32),
        _ => None,
    }
}

fn decode_html_entities(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(entity_start) = remainder.find('&') {
        decoded.push_str(&remainder[..entity_start]);
        remainder = &remainder[entity_start..];
        let Some(entity_end) = remainder.find(';').filter(|index| *index <= 12) else {
            decoded.push('&');
            remainder = &remainder[1..];
            continue;
        };
        if let Some(character) = decode_html_entity(&remainder[1..entity_end]) {
            decoded.push(character);
            remainder = &remainder[entity_end + 1..];
        } else {
            decoded.push_str(&remainder[..=entity_end]);
            remainder = &remainder[entity_end + 1..];
        }
    }
    decoded.push_str(remainder);
    decoded
}

fn metadata_text(value: &str, max_characters: usize) -> Option<String> {
    let decoded = decode_html_entities(value);
    let mut without_tags = String::with_capacity(decoded.len());
    let mut inside_tag = false;
    for character in decoded.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => without_tags.push(character),
            _ => {}
        }
    }
    let collapsed = without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(max_characters).collect())
}

fn html_attributes(tag: &str) -> HashMap<String, String> {
    let bytes = tag.as_bytes();
    let mut attributes = HashMap::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/')
        {
            cursor += 1;
        }
        let key_start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && !matches!(bytes[cursor], b'=' | b'/' | b'>')
        {
            cursor += 1;
        }
        if key_start == cursor {
            cursor += 1;
            continue;
        }
        let key = tag[key_start..cursor].to_ascii_lowercase();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            attributes.entry(key).or_default();
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            break;
        }
        let quote = matches!(bytes[cursor], b'\'' | b'"').then_some(bytes[cursor]);
        if quote.is_some() {
            cursor += 1;
        }
        let value_start = cursor;
        while cursor < bytes.len()
            && match quote {
                Some(quote) => bytes[cursor] != quote,
                None => {
                    !bytes[cursor].is_ascii_whitespace() && !matches!(bytes[cursor], b'/' | b'>')
                }
            }
        {
            cursor += 1;
        }
        attributes.insert(key, decode_html_entities(&tag[value_start..cursor]));
        if quote.is_some() && cursor < bytes.len() {
            cursor += 1;
        }
    }
    attributes
}

fn html_title(html: &str, lower_html: &str) -> Option<String> {
    let title_start = lower_html.find("<title")?;
    let content_start = title_start + lower_html[title_start..].find('>')? + 1;
    let content_end = content_start + lower_html[content_start..].find("</title>")?;
    metadata_text(&html[content_start..content_end], 200)
}

fn link_preview_metadata(html: &str, base_url: &Url) -> DesktopLinkPreviewMetadata {
    let lower_html = html.to_ascii_lowercase();
    let mut values = HashMap::<String, String>::new();
    let mut cursor = 0;
    while values.len() < 12 {
        let Some(relative_start) = lower_html[cursor..].find("<meta") else {
            break;
        };
        let tag_start = cursor + relative_start + 5;
        if !lower_html[tag_start..]
            .chars()
            .next()
            .is_some_and(|character| {
                character.is_ascii_whitespace() || character == '/' || character == '>'
            })
        {
            cursor = tag_start;
            continue;
        }
        let Some(relative_end) = lower_html[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end;
        let attributes = html_attributes(&html[tag_start..tag_end]);
        let key = attributes
            .get("property")
            .or_else(|| attributes.get("name"))
            .map(|value| value.to_ascii_lowercase());
        if let (Some(key), Some(content)) = (key, attributes.get("content")) {
            if matches!(
                key.as_str(),
                "description"
                    | "og:description"
                    | "og:image"
                    | "og:site_name"
                    | "og:title"
                    | "twitter:description"
                    | "twitter:image"
                    | "twitter:title"
            ) {
                values.entry(key).or_insert_with(|| content.clone());
            }
        }
        cursor = tag_end + 1;
    }

    let title = values
        .get("og:title")
        .or_else(|| values.get("twitter:title"))
        .and_then(|value| metadata_text(value, 200))
        .or_else(|| html_title(html, &lower_html));
    let description = values
        .get("og:description")
        .or_else(|| values.get("twitter:description"))
        .or_else(|| values.get("description"))
        .and_then(|value| metadata_text(value, 320));
    let image_url = values
        .get("og:image")
        .or_else(|| values.get("twitter:image"))
        .and_then(|value| base_url.join(value.trim()).ok())
        .and_then(|url| validated_remote_image_url(url.as_str()).ok())
        .map(|url| url.to_string());
    let site_name = values
        .get("og:site_name")
        .and_then(|value| metadata_text(value, 80));

    DesktopLinkPreviewMetadata {
        title,
        description,
        image_url,
        site_name,
    }
}

#[tauri::command]
pub async fn desktop_fetch_link_preview_metadata(
    url: String,
) -> Result<DesktopLinkPreviewMetadata, String> {
    let url = validated_remote_image_url(&url)?;
    tokio::time::timeout(LINK_PREVIEW_TIMEOUT, async move {
        let response = request_public_remote_image(url).await?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_LINK_PREVIEW_HTML_BYTES as u64)
        {
            return Err("Link preview page is larger than 256 KB.".to_string());
        }
        let is_html = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(supported_html_media_type);
        if !is_html {
            return Err("Link preview URL did not return HTML.".to_string());
        }
        let response_url = response.url().clone();
        let stream = response.bytes_stream();
        pin_mut!(stream);
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Unable to read link preview page.".to_string())?;
            if chunk.len() > MAX_LINK_PREVIEW_HTML_BYTES.saturating_sub(bytes.len()) {
                return Err("Link preview page is larger than 256 KB.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(link_preview_metadata(
            &String::from_utf8_lossy(&bytes),
            &response_url,
        ))
    })
    .await
    .map_err(|_| "Link preview request timed out.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_graph_metadata_and_resolves_public_images() {
        let metadata = link_preview_metadata(
            r#"<html><head>
                <meta content="Kordi &amp; Friends" property="og:title">
                <meta property='og:description' content='Build together &quot;without the busywork&quot;'>
                <meta property="og:image" content="/preview.jpg">
                <meta property="og:site_name" content="Kordi">
            </head></html>"#,
            &Url::parse("https://kordi.ai/docs/page").unwrap(),
        );

        assert_eq!(metadata.title.as_deref(), Some("Kordi & Friends"));
        assert_eq!(
            metadata.description.as_deref(),
            Some("Build together \"without the busywork\"")
        );
        assert_eq!(
            metadata.image_url.as_deref(),
            Some("https://kordi.ai/preview.jpg")
        );
        assert_eq!(metadata.site_name.as_deref(), Some("Kordi"));
    }

    #[test]
    fn falls_back_to_title_and_rejects_non_public_preview_images() {
        let metadata = link_preview_metadata(
            r#"<title>  A useful page  </title>
                <meta property="og:image" content="https://127.0.0.1/private.png">"#,
            &Url::parse("https://example.com/page").unwrap(),
        );

        assert_eq!(metadata.title.as_deref(), Some("A useful page"));
        assert_eq!(metadata.image_url, None);
    }

    #[test]
    fn link_preview_inputs_require_public_https_hosts() {
        assert!(validated_remote_image_url("https://example.com/page").is_ok());
        assert!(validated_remote_image_url("http://example.com/page").is_err());
        assert!(validated_remote_image_url("https://localhost/page").is_err());
        assert!(validated_remote_image_url("https://192.168.1.2/page").is_err());
    }
}
