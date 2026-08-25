use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_postgres::{PgPool, Postgres};
use tokio::sync::Semaphore;

use crate::attachments::{presign_upload_url, S3Config};
use crate::avatars::AvatarMutationRequest;

mod backfill;
mod routes;

pub use backfill::backfill_inline_avatars;
pub use routes::{render_uploaded_avatar, upload_avatar_asset};

pub const AVATAR_SOURCE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const AVATAR_SOURCE_MAX_PIXELS: u64 = 24_000_000;
pub const AVATAR_VARIANT_SIZES: [u32; 4] = [64, 128, 256, 512];
const AVATAR_JPEG_QUALITY: u8 = 82;
const UPLOADED_AVATAR_HOST: &str = "uploaded";
const MAX_SERVED_AVATAR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadedAvatarMarker {
    pub asset_id: String,
}

#[derive(Debug)]
pub enum AvatarAssetError {
    Invalid(&'static str),
    Unavailable,
    Database(sqlx_core::Error),
    ObjectStore,
}

impl std::fmt::Display for AvatarAssetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Unavailable => formatter.write_str("Avatar storage is unavailable."),
            Self::Database(error) => write!(formatter, "avatar database error: {error}"),
            Self::ObjectStore => formatter.write_str("Avatar object storage failed."),
        }
    }
}

impl std::error::Error for AvatarAssetError {}

impl From<sqlx_core::Error> for AvatarAssetError {
    fn from(value: sqlx_core::Error) -> Self {
        Self::Database(value)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAvatarQuery {
    entity_type: String,
    entity_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadAvatarResponse {
    uploaded_asset: String,
}

#[derive(Debug)]
pub struct NormalizedAvatar {
    pub source_content_type: &'static str,
    pub source_size_bytes: usize,
    pub source_width: u32,
    pub source_height: u32,
    pub variants: Vec<(u32, Vec<u8>)>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarBackfillSummary {
    pub migrated: usize,
    pub skipped: usize,
    pub failed: usize,
}

pub fn uploaded_avatar_marker(asset_id: &str) -> Option<String> {
    valid_asset_id(asset_id).then(|| format!("kordi-avatar://{UPLOADED_AVATAR_HOST}/{asset_id}"))
}

pub fn parse_uploaded_avatar_marker(value: &str) -> Option<UploadedAvatarMarker> {
    let url = url::Url::parse(value.trim()).ok()?;
    if url.scheme() != "kordi-avatar" || url.host_str()? != UPLOADED_AVATAR_HOST {
        return None;
    }
    let mut segments = url.path_segments()?;
    let asset_id = segments.next()?.to_string();
    if segments.next().is_some() || !valid_asset_id(&asset_id) {
        return None;
    }
    Some(UploadedAvatarMarker { asset_id })
}

pub fn legacy_avatar_data(value: &str) -> Result<Option<Vec<u8>>, AvatarAssetError> {
    let raw = value.trim();
    if !raw.to_ascii_lowercase().starts_with("data:image/") {
        return Ok(None);
    }
    let Some((metadata, payload)) = raw.split_once(',') else {
        return Err(AvatarAssetError::Invalid("Avatar image data is malformed."));
    };
    if !matches!(
        metadata.to_ascii_lowercase().as_str(),
        "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
    ) {
        return Err(AvatarAssetError::Invalid(
            "Avatar must be a PNG, JPEG, or WebP image.",
        ));
    }
    let decoded = STANDARD
        .decode(payload)
        .map_err(|_| AvatarAssetError::Invalid("Avatar image data is invalid."))?;
    if decoded.len() > AVATAR_SOURCE_MAX_BYTES {
        return Err(AvatarAssetError::Invalid("Avatar source exceeds 2 MiB."));
    }
    Ok(Some(decoded))
}

pub fn clean_uploaded_avatar(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if parse_uploaded_avatar_marker(raw).is_some() {
        return Ok(Some(raw.to_string()));
    }
    legacy_avatar_data(raw)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Avatar must be a PNG, JPEG, or WebP image.".to_string())?;
    Ok(Some(raw.to_string()))
}

pub fn normalize_avatar(bytes: &[u8]) -> Result<NormalizedAvatar, AvatarAssetError> {
    if bytes.is_empty() {
        return Err(AvatarAssetError::Invalid("Choose an avatar image."));
    }
    if bytes.len() > AVATAR_SOURCE_MAX_BYTES {
        return Err(AvatarAssetError::Invalid("Avatar source exceeds 2 MiB."));
    }
    let format = image::guess_format(bytes)
        .map_err(|_| AvatarAssetError::Invalid("Avatar must be a PNG, JPEG, or WebP image."))?;
    let source_content_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => {
            return Err(AvatarAssetError::Invalid(
                "Avatar must be a PNG, JPEG, or WebP image.",
            ))
        }
    };
    let reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| AvatarAssetError::Invalid("Avatar image could not be decoded."))?;
    let (source_width, source_height) = decoder.dimensions();
    let pixels = u64::from(source_width).saturating_mul(u64::from(source_height));
    if source_width == 0 || source_height == 0 || pixels > AVATAR_SOURCE_MAX_PIXELS {
        return Err(AvatarAssetError::Invalid(
            "Avatar dimensions are too large.",
        ));
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| AvatarAssetError::Invalid("Avatar image could not be decoded."))?;
    image.apply_orientation(orientation);
    let side = image.width().min(image.height());
    let x = (image.width() - side) / 2;
    let y = (image.height() - side) / 2;
    let square = image.crop_imm(x, y, side, side);
    let variants = AVATAR_VARIANT_SIZES
        .into_iter()
        .map(|size| {
            let resized = square.resize_exact(size, size, FilterType::Lanczos3);
            let rgb = flatten_on_white(&resized);
            let mut encoded = Vec::new();
            JpegEncoder::new_with_quality(&mut encoded, AVATAR_JPEG_QUALITY)
                .encode_image(&DynamicImage::ImageRgb8(rgb))
                .map_err(|_| AvatarAssetError::Invalid("Avatar image could not be encoded."))?;
            Ok((size, encoded))
        })
        .collect::<Result<Vec<_>, AvatarAssetError>>()?;
    Ok(NormalizedAvatar {
        source_content_type,
        source_size_bytes: bytes.len(),
        source_width,
        source_height,
        variants,
    })
}

pub async fn store_avatar_asset(
    pool: &PgPool,
    s3: &S3Config,
    owner_account_id: &str,
    entity_type: &str,
    entity_id: &str,
    bytes: Vec<u8>,
) -> Result<String, AvatarAssetError> {
    if !matches!(entity_type, "human" | "agent") || entity_id.trim().is_empty() {
        return Err(AvatarAssetError::Invalid("Avatar target is invalid."));
    }
    let permit = avatar_transform_semaphore()
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AvatarAssetError::Unavailable)?;
    let normalized = tokio::task::spawn_blocking(move || normalize_avatar(&bytes))
        .await
        .map_err(|_| AvatarAssetError::Unavailable)??;
    drop(permit);

    let asset_id = format!("ava_{}", uuid::Uuid::new_v4().simple());
    let object_prefix = format!("avatars/{entity_type}/{entity_id}/{asset_id}");
    for (size, variant) in &normalized.variants {
        let object_key = format!("{object_prefix}/{size}.jpg");
        let url = presign_upload_url(s3, &object_key).map_err(|_| AvatarAssetError::ObjectStore)?;
        let response = object_store_client()
            .put(url.to_string())
            .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
            .body(variant.clone())
            .send()
            .await
            .map_err(|_| AvatarAssetError::ObjectStore)?;
        if !response.status().is_success() {
            return Err(AvatarAssetError::ObjectStore);
        }
    }
    query(
        "INSERT INTO cloud_avatar_assets \
         (asset_id, owner_account_id, entity_type, entity_id, object_prefix, \
          source_content_type, source_size_bytes, source_width, source_height) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&asset_id)
    .bind(owner_account_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(&object_prefix)
    .bind(normalized.source_content_type)
    .bind(normalized.source_size_bytes as i64)
    .bind(normalized.source_width as i32)
    .bind(normalized.source_height as i32)
    .execute(pool)
    .await?;
    uploaded_avatar_marker(&asset_id).ok_or(AvatarAssetError::Unavailable)
}

pub async fn materialize_legacy_avatar_mutation(
    pool: &PgPool,
    s3: Option<&S3Config>,
    owner_account_id: &str,
    entity_type: &str,
    entity_id: &str,
    mutation: &mut AvatarMutationRequest,
) -> Result<(), AvatarAssetError> {
    if mutation.action.trim() != "upload" {
        return Ok(());
    }
    let Some(value) = mutation.uploaded_asset.as_deref() else {
        return Ok(());
    };
    let Some(bytes) = legacy_avatar_data(value)? else {
        return Ok(());
    };
    let s3 = s3.ok_or(AvatarAssetError::Unavailable)?;
    mutation.uploaded_asset =
        Some(store_avatar_asset(pool, s3, owner_account_id, entity_type, entity_id, bytes).await?);
    Ok(())
}

pub async fn activate_avatar_asset(
    transaction: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    owner_account_id: &str,
    entity_type: &str,
    entity_id: &str,
    marker: &str,
) -> Result<(), AvatarAssetError> {
    let parsed = parse_uploaded_avatar_marker(marker).ok_or(AvatarAssetError::Invalid(
        "Uploaded avatar reference is invalid.",
    ))?;
    let result = query(
        "UPDATE cloud_avatar_assets SET activated_at = COALESCE(activated_at, now()) \
         WHERE asset_id = $1 AND owner_account_id = $2 AND entity_type = $3 AND entity_id = $4",
    )
    .bind(&parsed.asset_id)
    .bind(owner_account_id)
    .bind(entity_type)
    .bind(entity_id)
    .execute(&mut **transaction)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AvatarAssetError::Invalid(
            "Uploaded avatar reference is unavailable.",
        ));
    }
    Ok(())
}

fn flatten_on_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let blend = |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
        rgb.put_pixel(
            x,
            y,
            Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    rgb
}

fn valid_asset_id(value: &str) -> bool {
    value.strip_prefix("ava_").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn object_store_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn avatar_transform_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(4)))
}
