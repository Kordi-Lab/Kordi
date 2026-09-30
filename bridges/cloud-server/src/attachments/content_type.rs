use axum::http::{header, HeaderMap, HeaderValue};

/// Media types that attachment bytes may be served as from the API origin:
/// raster images, audio, and video. Document and script-capable types such as
/// SVG, HTML, XML, JavaScript, and PDF are never rendered inline.
const INLINE_MEDIA_TYPES: &[&str] = &[
    "image/apng",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heic-sequence",
    "image/heif",
    "image/heif-sequence",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/vnd.microsoft.icon",
    "image/webp",
    "image/x-icon",
    "image/x-ms-bmp",
    "audio/3gpp",
    "audio/aac",
    "audio/aiff",
    "audio/amr",
    "audio/basic",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/wave",
    "audio/webm",
    "audio/x-aac",
    "audio/x-aiff",
    "audio/x-caf",
    "audio/x-flac",
    "audio/x-m4a",
    "audio/x-wav",
    "video/3gpp",
    "video/3gpp2",
    "video/mp2t",
    "video/mp4",
    "video/mpeg",
    "video/ogg",
    "video/quicktime",
    "video/webm",
    "video/x-m4v",
    "video/x-matroska",
    "video/x-msvideo",
];

/// Content type for attachment bytes that are not an allowlisted media type.
pub(crate) const OPAQUE_CONTENT_TYPE: &str = "application/octet-stream";
/// Attachment bytes are data, never an active document on the API origin.
pub(crate) const ATTACHMENT_CONTENT_SECURITY_POLICY: &str = "default-src 'none'; sandbox";

/// Returns the canonical allowlisted media type for a declared or detected
/// content type, ignoring parameters and case.
pub(crate) fn inline_media_type(value: &str) -> Option<&'static str> {
    let essence = value.split(';').next()?.trim().to_ascii_lowercase();
    let essence = if essence == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        essence
    };
    INLINE_MEDIA_TYPES
        .iter()
        .copied()
        .find(|media_type| *media_type == essence)
}

/// Picks the first allowlisted media type from the candidates, in order.
pub(crate) fn served_media_type<'a>(
    candidates: impl IntoIterator<Item = Option<&'a str>>,
) -> Option<&'static str> {
    candidates.into_iter().flatten().find_map(inline_media_type)
}

/// Sets the type and safety headers for attachment bytes. Allowlisted media
/// is served with its media type; everything else is an opaque download.
pub(crate) fn apply_attachment_response_headers(
    headers: &mut HeaderMap,
    media_type: Option<&'static str>,
) {
    match media_type {
        Some(media_type) => {
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type));
            headers.remove(header::CONTENT_DISPOSITION);
        }
        None => {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(OPAQUE_CONTENT_TYPE),
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment"),
            );
        }
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(ATTACHMENT_CONTENT_SECURITY_POLICY),
    );
}

pub(super) fn detected_raster_content_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

pub(super) fn detected_supported_content_type(bytes: &[u8]) -> Option<&'static str> {
    detected_raster_content_type(bytes).or_else(|| {
        if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
            return None;
        }
        let box_size = u32::from_be_bytes(bytes[..4].try_into().ok()?) as usize;
        if box_size < 16 || box_size > bytes.len() {
            return None;
        }
        let major = bytes[8..12].first_chunk::<4>()?;
        let heic = std::iter::once(major)
            .chain(bytes[16..box_size].as_chunks::<4>().0.iter())
            .any(|brand| matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx"));
        if heic {
            return Some("image/heic");
        }
        match major {
            b"mif1" | b"msf1" => Some("image/heif"),
            b"qt  " => Some("video/quicktime"),
            _ => Some("video/mp4"),
        }
    })
}

pub(super) fn normalized_supported_raster_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

pub(super) fn normalized_verified_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "video/mp4" => Some("video/mp4"),
        "video/quicktime" => Some("video/quicktime"),
        "image/heic" => Some("image/heic"),
        "image/heif" => Some("image/heif"),
        value => normalized_supported_raster_content_type(value),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_attachment_response_headers, detected_raster_content_type,
        detected_supported_content_type, inline_media_type,
        normalized_supported_raster_content_type, normalized_verified_content_type,
        served_media_type, ATTACHMENT_CONTENT_SECURITY_POLICY,
    };
    use axum::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn only_raster_images_audio_and_video_are_served_inline() {
        for (declared, served) in [
            ("image/png", "image/png"),
            (" IMAGE/JPG ", "image/jpeg"),
            ("image/heic", "image/heic"),
            ("audio/x-m4a", "audio/x-m4a"),
            ("audio/mp4; codecs=mp4a.40.2", "audio/mp4"),
            ("video/quicktime", "video/quicktime"),
            ("video/mp4", "video/mp4"),
        ] {
            assert_eq!(inline_media_type(declared), Some(served), "{declared}");
        }
        for declared in [
            "image/svg+xml",
            "text/html",
            "text/html; charset=utf-8",
            "application/xhtml+xml",
            "text/xml",
            "application/xml",
            "application/javascript",
            "text/javascript",
            "application/pdf",
            "text/plain",
            "application/octet-stream",
            "audio/x-mpegurl",
            "application/vnd.apple.mpegurl",
            "multipart/x-mixed-replace",
            "",
        ] {
            assert_eq!(inline_media_type(declared), None, "{declared}");
        }
        assert_eq!(
            served_media_type([None, Some("application/octet-stream"), Some("audio/mpeg")]),
            Some("audio/mpeg")
        );
        assert_eq!(
            served_media_type([Some("image/png"), Some("text/html")]),
            Some("image/png")
        );
        assert_eq!(served_media_type([None, Some("text/html")]), None);
    }

    #[test]
    fn attachment_headers_disable_sniffing_and_active_content() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        apply_attachment_response_headers(&mut headers, None);
        assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
        assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            ATTACHMENT_CONTENT_SECURITY_POLICY
        );

        let mut headers = HeaderMap::new();
        apply_attachment_response_headers(&mut headers, Some("video/mp4"));
        assert_eq!(headers[header::CONTENT_TYPE], "video/mp4");
        assert!(headers.get(header::CONTENT_DISPOSITION).is_none());
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detected_raster_content_type(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(
            detected_raster_content_type(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(detected_raster_content_type(b"GIF89a"), Some("image/gif"));
        assert_eq!(
            detected_raster_content_type(b"RIFF\0\0\0\0WEBP"),
            Some("image/webp")
        );
        assert_eq!(detected_raster_content_type(b"not an image"), None);
    }

    #[test]
    fn normalizes_only_supported_image_types() {
        assert_eq!(
            normalized_supported_raster_content_type(" IMAGE/JPG "),
            Some("image/jpeg")
        );
        assert_eq!(normalized_supported_raster_content_type("image/heic"), None);
    }

    #[test]
    fn distinguishes_live_photo_resources_from_mp4() {
        assert_eq!(
            detected_supported_content_type(b"\0\0\0\x14ftypmif1\0\0\0\0heic"),
            Some("image/heic")
        );
        assert_eq!(
            detected_supported_content_type(b"\0\0\0\x14ftypqt  \0\0\0\0qt  "),
            Some("video/quicktime")
        );
        assert_eq!(
            normalized_verified_content_type("image/heic"),
            Some("image/heic")
        );
        assert_eq!(
            normalized_verified_content_type("video/quicktime"),
            Some("video/quicktime")
        );
        assert_eq!(
            detected_supported_content_type(b"\0\0\xFF\xFFftypheic\0\0\0\0"),
            None
        );
    }

    #[test]
    fn detects_and_normalizes_mp4_containers() {
        assert_eq!(
            detected_supported_content_type(b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom"),
            Some("video/mp4")
        );
        assert_eq!(
            normalized_verified_content_type(" VIDEO/MP4 "),
            Some("video/mp4")
        );
        assert_eq!(detected_supported_content_type(b"not a video"), None);
    }
}
