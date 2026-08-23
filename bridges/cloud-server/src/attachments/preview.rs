use axum::body::Bytes;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::attachments::response::boxed_err;

pub(crate) fn normalize_preview_url(value: Option<&str>) -> Result<String, Box<Response>> {
    let Some(raw) = value else {
        return Err(invalid_preview("previewUrl is required."));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid_preview("previewUrl is required."));
    }
    if trimmed.len() > 360_000 {
        return Err(invalid_preview("Attachment preview is too large."));
    }
    decode_preview_data_url(trimmed)
        .map_err(|_| invalid_preview("Attachment preview must be a supported image data URL."))?;
    Ok(trimmed.to_string())
}

pub(crate) fn preview_content_response(value: Option<&str>) -> Result<Response, Box<Response>> {
    let value = value.ok_or_else(|| {
        boxed_err(
            "preview_not_found",
            "Attachment preview is not available.",
            StatusCode::NOT_FOUND,
        )
    })?;
    let (content_type, bytes) = decode_preview_data_url(value).map_err(|_| {
        boxed_err(
            "invalid_attachment_preview",
            "Attachment preview is invalid.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(length) = HeaderValue::from_str(&bytes.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, length);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok((headers, Bytes::from(bytes)).into_response())
}

fn invalid_preview(message: &'static str) -> Box<Response> {
    boxed_err("invalid_attachment", message, StatusCode::BAD_REQUEST)
}

fn decode_preview_data_url(value: &str) -> Result<(&'static str, Vec<u8>), ()> {
    let (metadata, encoded) = value.trim().split_once(',').ok_or(())?;
    let content_type = match metadata.to_ascii_lowercase().as_str() {
        "data:image/png;base64" => "image/png",
        "data:image/jpeg;base64" | "data:image/jpg;base64" => "image/jpeg",
        "data:image/webp;base64" => "image/webp",
        "data:image/gif;base64" => "image/gif",
        _ => return Err(()),
    };
    STANDARD
        .decode(encoded)
        .map(|bytes| (content_type, bytes))
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{decode_preview_data_url, normalize_preview_url};

    #[test]
    fn preview_data_urls_decode_with_their_image_type() {
        let (content_type, bytes) =
            decode_preview_data_url("data:image/png;base64,iVBORw==").unwrap();
        assert_eq!(content_type, "image/png");
        assert_eq!(bytes, [0x89, 0x50, 0x4e, 0x47]);
    }

    #[test]
    fn preview_validation_rejects_non_image_and_malformed_data() {
        assert!(normalize_preview_url(Some("data:text/plain;base64,SGVsbG8=")).is_err());
        assert!(normalize_preview_url(Some("data:image/png;base64,not-base64")).is_err());
    }
}
