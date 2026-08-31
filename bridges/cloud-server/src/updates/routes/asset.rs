use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;

use super::{not_found, unavailable};
use crate::updates::model::ReleaseAsset;
use crate::updates::store::{ReleaseByteRange, ReleaseCatalogStore, ReleaseStoreError};

fn requested_range(
    headers: &HeaderMap,
    size_bytes: u64,
    etag: &str,
    last_modified: &str,
) -> Result<Option<ReleaseByteRange>, ()> {
    let mut values = headers.get_all(header::RANGE).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    if headers.get(header::IF_RANGE).is_some_and(|value| {
        value.as_bytes() != etag.as_bytes() && value.as_bytes() != last_modified.as_bytes()
    }) {
        return Ok(None);
    }
    let value = value.to_str().map_err(|_| ())?.trim();
    let spec = value.strip_prefix("bytes=").ok_or(())?;
    if spec.contains(',') {
        return Err(());
    }
    let (start, end) = spec.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some(ReleaseByteRange {
            start: size_bytes.saturating_sub(suffix),
            end_inclusive: size_bytes - 1,
            complete_length: size_bytes,
        }));
    }

    let start: u64 = start.parse().map_err(|_| ())?;
    if start >= size_bytes {
        return Err(());
    }
    let end_inclusive = if end.is_empty() {
        size_bytes - 1
    } else {
        let end: u64 = end.parse().map_err(|_| ())?;
        if end < start {
            return Err(());
        }
        end.min(size_bytes - 1)
    };
    Ok(Some(ReleaseByteRange {
        start,
        end_inclusive,
        complete_length: size_bytes,
    }))
}

fn apply_asset_headers(
    response: &mut Response,
    asset: &ReleaseAsset,
    content_length: u64,
    cache_control: &'static str,
    last_modified: &str,
) -> Result<(), ()> {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type).map_err(|_| ())?,
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string()).map_err(|_| ())?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    headers.insert(
        HeaderName::from_static("x-checksum-sha256"),
        HeaderValue::from_str(&asset.sha256).map_err(|_| ())?,
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", asset.sha256)).map_err(|_| ())?,
    );
    headers.insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(last_modified).map_err(|_| ())?,
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    Ok(())
}

pub(super) async fn asset_response(
    store: &ReleaseCatalogStore,
    asset: &ReleaseAsset,
    pub_date: &str,
    request_headers: &HeaderMap,
    head_only: bool,
    cache_control: &'static str,
) -> Response {
    let etag = format!("\"{}\"", asset.sha256);
    let Ok(publication_date) = chrono::DateTime::parse_from_rfc3339(pub_date) else {
        return unavailable();
    };
    let last_modified = publication_date
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let byte_range = if head_only {
        None
    } else {
        match requested_range(request_headers, asset.size_bytes, &etag, &last_modified) {
            Ok(byte_range) => byte_range,
            Err(()) => {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                if apply_asset_headers(&mut response, asset, 0, cache_control, &last_modified)
                    .is_err()
                {
                    return unavailable();
                }
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{}", asset.size_bytes)).unwrap(),
                );
                return response;
            }
        }
    };
    let body = if head_only {
        if store.verify_asset_size(asset).await.is_err() {
            return unavailable();
        }
        Body::empty()
    } else {
        let object = match store.open_asset(asset, byte_range).await {
            Ok(object) => object,
            Err(ReleaseStoreError::NotFound) => return not_found(),
            Err(_) => return unavailable(),
        };
        Body::from_stream(object.body)
    };

    let mut response = Response::new(body);
    *response.status_mut() = if byte_range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let content_length = byte_range
        .and_then(ReleaseByteRange::length)
        .unwrap_or(asset.size_bytes);
    if apply_asset_headers(
        &mut response,
        asset,
        content_length,
        cache_control,
        &last_modified,
    )
    .is_err()
    {
        return unavailable();
    }
    if let Some(range) = byte_range {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!(
                "bytes {}-{}/{}",
                range.start, range.end_inclusive, range.complete_length
            ))
            .unwrap(),
        );
    }
    response
}
