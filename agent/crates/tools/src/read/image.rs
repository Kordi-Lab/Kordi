use kordi_core::error::{KordiError, KordiResult};
use std::path::Path;
use tokio::io::AsyncReadExt;

use crate::{ToolResult, support::image_result};

pub(super) use crate::image_input::is_image_path as is_image;

pub(super) async fn read_image(path: &Path) -> KordiResult<ToolResult> {
    if !tokio::fs::metadata(path).await?.is_file() {
        return Err(KordiError::Tool(
            "Image input must be a regular file.".into(),
        ));
    }
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(crate::image_input::MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    let content = tokio::task::spawn_blocking(move || crate::image_input::image_content(&bytes))
        .await
        .map_err(|_| KordiError::Tool("Image decoding failed.".into()))??;
    Ok(image_result(content))
}
