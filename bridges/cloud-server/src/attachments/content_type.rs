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

pub(super) fn normalized_supported_raster_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{detected_raster_content_type, normalized_supported_raster_content_type};

    #[test]
    fn detects_supported_meme_image_signatures() {
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
    fn normalizes_only_supported_meme_image_types() {
        assert_eq!(
            normalized_supported_raster_content_type(" IMAGE/JPG "),
            Some("image/jpeg")
        );
        assert_eq!(normalized_supported_raster_content_type("image/heic"), None);
    }
}
