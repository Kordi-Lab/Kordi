//! Bounded, validated image payloads shared by local and cloud file tools.

use base64::Engine;
use kordi_core::error::{KordiError, KordiResult};
use kordi_core::types::ContentBlock;
use std::io::Cursor;
use std::path::Path;

pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

pub fn is_image_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        matches!(
            e.to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp"
        )
    })
}

pub fn image_content(bytes: &[u8]) -> KordiResult<ContentBlock> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(KordiError::Tool(
            "Image must be nonempty and no larger than 4 MiB; resize it and retry.".into(),
        ));
    }
    let format = image::guess_format(bytes).map_err(|_| {
        KordiError::Tool("Invalid or unsupported image; use PNG, JPEG, WebP, or GIF.".into())
    })?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Gif => "image/gif",
        _ => {
            return Err(KordiError::Tool(
                "Unsupported image format; use PNG, JPEG, WebP, or GIF.".into(),
            ));
        }
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| {
        KordiError::Tool(
            "Image is corrupt or exceeds decoding limits; resize or re-export it and retry.".into(),
        )
    })?;
    Ok(ContentBlock::Image {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: mime.into(),
    })
}
