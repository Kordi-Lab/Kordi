//! Bounded, validated image payloads shared by local and cloud file tools.

use base64::Engine;
use kordi_core::error::{KordiError, KordiResult};
use kordi_core::types::ContentBlock;
use std::io::Cursor;
use std::path::Path;

pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

/// Chat attachment retrieval never presents an animation's first frame as the
/// meaning of the entire sticker. Animated media needs a sampling workflow.
pub fn static_image_content(bytes: &[u8]) -> KordiResult<ContentBlock> {
    use image::{AnimationDecoder, ImageDecoder};
    let content = image_content(bytes)?;
    let invalid = || {
        KordiError::Tool(
            "Animated or invalid media is not supported by static image retrieval.".into(),
        )
    };
    let animated = match image::guess_format(bytes).map_err(|_| invalid())? {
        image::ImageFormat::Gif => {
            let mut decoder =
                image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(|_| invalid())?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(128 * 1024 * 1024);
            limits.max_image_width = Some(8192);
            limits.max_image_height = Some(8192);
            decoder.set_limits(limits).map_err(|_| invalid())?;
            let frames = decoder
                .into_frames()
                .take(2)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid())?;
            frames.len() > 1
        }
        image::ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(|_| invalid())?
            .has_animation(),
        image::ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(bytes))
            .map_err(|_| invalid())?
            .is_apng()
            .map_err(|_| invalid())?,
        _ => false,
    };
    if animated {
        Err(invalid())
    } else {
        Ok(content)
    }
}

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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn static_chat_reader_rejects_animation_instead_of_showing_only_its_first_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            let frames = [
                image::Frame::new(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([255, 0, 0, 255]),
                )),
                image::Frame::new(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([0, 0, 255, 255]),
                )),
            ];
            encoder.encode_frames(frames).unwrap();
        }
        assert!(image_content(&bytes).is_ok());
        assert!(static_image_content(&bytes).is_err());
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert!(static_image_content(png.get_ref()).is_ok());
    }
}
