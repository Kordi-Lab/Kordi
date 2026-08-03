use std::{
    fmt::Display,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{pin_mut, Stream, StreamExt};
use reqwest::{
    header::{CONTENT_TYPE, LOCATION},
    redirect::Policy,
    Response, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_REMOTE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS: usize = 3;
const REMOTE_IMAGE_TIMEOUT: Duration = Duration::from_secs(15);
const REMOTE_IMAGE_CACHE_VERSION: u8 = 1;
const REMOTE_IMAGE_CACHE_MAGIC: &[u8] = b"KORDI_REMOTE_AVATAR_V1\n";
const REMOTE_IMAGE_CACHE_EXTENSION: &str = "avatar";
const REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES: usize = 4 * 1024;
const REMOTE_IMAGE_CACHE_MAX_ENTRIES: usize = 128;
const REMOTE_IMAGE_CACHE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const REMOTE_IMAGE_CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RemoteImageCacheHeader {
    version: u8,
    url_sha256: String,
    media_type: String,
    content_sha256: String,
    byte_len: usize,
    cached_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteImagePayload {
    media_type: String,
    bytes: Vec<u8>,
}

fn is_public_remote_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _fourth] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 88 && third == 99)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113))
}

fn is_public_remote_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4() {
        return is_public_remote_ipv4(mapped);
    }
    let segments = address.segments();
    if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        let embedded = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        );
        return is_public_remote_ipv4(embedded);
    }
    // RFC 8215 reserves 64:ff9b:1::/48 for local use; never treat it as public even when its embedded IPv4 address
    // is not represented in the well-known /96 layout above.
    if segments[..3] == [0x0064, 0xff9b, 0x0001] {
        return false;
    }

    let is_global_unicast = segments[0] & 0xe000 == 0x2000;
    let is_special_registry = segments[0] == 0x2001 && segments[1] <= 0x01ff;
    let is_documentation = (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0);
    let is_six_to_four = segments[0] == 0x2002;
    is_global_unicast && !is_special_registry && !is_documentation && !is_six_to_four
}

fn is_public_remote_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_remote_ipv4(address),
        IpAddr::V6(address) => is_public_remote_ipv6(address),
    }
}

fn validated_remote_image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Avatar image URL is invalid.".to_string())?;
    if url.scheme() != "https" {
        return Err("Avatar image URL must use HTTPS.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Avatar image URL must not contain credentials.".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".local") {
        return Err("Avatar image URL must use a public host.".to_string());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_remote_ip(address) {
            return Err("Avatar image URL must use a public host.".to_string());
        }
    }
    Ok(url)
}

fn supported_image_media_type(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        "image/avif" => Some("image/avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

fn remote_image_data_url(media_type: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Avatar image response was empty.".to_string());
    }
    if bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err("Avatar image is larger than 2 MB.".to_string());
    }
    Ok(format!(
        "data:{media_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn remote_image_url_cache_key(url: &str) -> String {
    sha256_hex(url.as_bytes())
}

fn remote_image_cache_dir(storage_root: &str) -> PathBuf {
    PathBuf::from(storage_root)
        .join("cache")
        .join("remote-avatars-v1")
}

fn active_remote_image_cache_dir() -> Option<PathBuf> {
    crate::cloud_account_paths::cloud_account_storage_current()
        .ok()
        .flatten()
        .map(|activation| remote_image_cache_dir(&activation.storage_root))
}

fn remote_image_cache_entry_path(cache_dir: &Path, url: &str) -> PathBuf {
    cache_dir.join(format!(
        "{}.{}",
        remote_image_url_cache_key(url),
        REMOTE_IMAGE_CACHE_EXTENSION
    ))
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn encode_remote_image_cache_entry(
    url: &str,
    media_type: &str,
    bytes: &[u8],
    cached_at_unix_seconds: u64,
) -> Result<Vec<u8>, String> {
    let media_type = supported_image_media_type(media_type)
        .ok_or_else(|| "Avatar cache media type is not supported.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err("Avatar cache body is outside the allowed size.".to_string());
    }
    let header = RemoteImageCacheHeader {
        version: REMOTE_IMAGE_CACHE_VERSION,
        url_sha256: remote_image_url_cache_key(url),
        media_type: media_type.to_string(),
        content_sha256: sha256_hex(bytes),
        byte_len: bytes.len(),
        cached_at_unix_seconds,
    };
    let encoded_header = serde_json::to_vec(&header)
        .map_err(|error| format!("Unable to encode avatar cache metadata: {error}"))?;
    if encoded_header.len() > REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES {
        return Err("Avatar cache metadata is too large.".to_string());
    }
    let mut encoded =
        Vec::with_capacity(REMOTE_IMAGE_CACHE_MAGIC.len() + encoded_header.len() + 1 + bytes.len());
    encoded.extend_from_slice(REMOTE_IMAGE_CACHE_MAGIC);
    encoded.extend_from_slice(&encoded_header);
    encoded.push(b'\n');
    encoded.extend_from_slice(bytes);
    Ok(encoded)
}

fn decode_remote_image_cache_entry(
    url: &str,
    encoded: &[u8],
    now_unix_seconds: u64,
) -> Result<RemoteImagePayload, String> {
    if encoded.len()
        > REMOTE_IMAGE_CACHE_MAGIC.len()
            + REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES
            + 1
            + MAX_REMOTE_IMAGE_BYTES
    {
        return Err("Avatar cache entry is too large.".to_string());
    }
    let remainder = encoded
        .strip_prefix(REMOTE_IMAGE_CACHE_MAGIC)
        .ok_or_else(|| "Avatar cache entry has an invalid format.".to_string())?;
    let header_end = remainder
        .iter()
        .take(REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES + 1)
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Avatar cache metadata is incomplete.".to_string())?;
    let header: RemoteImageCacheHeader = serde_json::from_slice(&remainder[..header_end])
        .map_err(|_| "Avatar cache metadata is invalid.".to_string())?;
    let bytes = &remainder[header_end + 1..];

    if header.version != REMOTE_IMAGE_CACHE_VERSION
        || header.url_sha256 != remote_image_url_cache_key(url)
        || header.byte_len != bytes.len()
        || bytes.is_empty()
        || bytes.len() > MAX_REMOTE_IMAGE_BYTES
        || supported_image_media_type(&header.media_type).is_none()
        || header.content_sha256 != sha256_hex(bytes)
    {
        return Err("Avatar cache entry failed validation.".to_string());
    }
    if header.cached_at_unix_seconds > now_unix_seconds.saturating_add(5 * 60)
        || now_unix_seconds.saturating_sub(header.cached_at_unix_seconds)
            > REMOTE_IMAGE_CACHE_TTL.as_secs()
    {
        return Err("Avatar cache entry has expired.".to_string());
    }

    Ok(RemoteImagePayload {
        media_type: header.media_type,
        bytes: bytes.to_vec(),
    })
}

fn read_cached_remote_image(
    cache_dir: &Path,
    url: &str,
    now_unix_seconds: u64,
) -> Option<RemoteImagePayload> {
    let path = remote_image_cache_entry_path(cache_dir, url);
    let encoded = match std::fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };
    match decode_remote_image_cache_entry(url, &encoded, now_unix_seconds) {
        Ok(payload) => Some(payload),
        Err(_) => {
            let _ = std::fs::remove_file(path);
            None
        }
    }
}

fn prune_remote_image_cache(
    cache_dir: &Path,
    max_entries: usize,
    max_bytes: u64,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(cache_dir)
        .map_err(|error| format!("Unable to inspect avatar cache: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("tmp") {
                let _ = std::fs::remove_file(path);
                return None;
            }
            if path.extension().and_then(|value| value.to_str())
                != Some(REMOTE_IMAGE_CACHE_EXTENSION)
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            Some((path, metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut total_bytes = entries.iter().map(|(_, length, _)| *length).sum::<u64>();
    let mut entry_count = entries.len();
    for (path, length, _) in entries {
        if entry_count <= max_entries && total_bytes <= max_bytes {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            entry_count = entry_count.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(length);
        }
    }
    Ok(())
}

fn write_cached_remote_image(
    cache_dir: &Path,
    url: &str,
    media_type: &str,
    bytes: &[u8],
    now_unix_seconds: u64,
) -> Result<(), String> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|error| format!("Unable to create avatar cache: {error}"))?;
    let encoded = encode_remote_image_cache_entry(url, media_type, bytes, now_unix_seconds)?;
    let destination = remote_image_cache_entry_path(cache_dir, url);
    let temporary = cache_dir.join(format!(
        ".{}.{}.tmp",
        remote_image_url_cache_key(url),
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = std::fs::write(&temporary, encoded) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Unable to write avatar cache: {error}"));
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Unable to commit avatar cache: {error}"));
    }
    prune_remote_image_cache(
        cache_dir,
        REMOTE_IMAGE_CACHE_MAX_ENTRIES,
        REMOTE_IMAGE_CACHE_MAX_BYTES,
    )
}

async fn resolve_public_remote_image_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Avatar image URL is missing a usable port.".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Unable to resolve avatar image host: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("Avatar image host did not resolve to an address.".to_string());
    }
    if addresses
        .iter()
        .any(|address| !is_public_remote_ip(address.ip()))
    {
        return Err("Avatar image URL must resolve only to public addresses.".to_string());
    }
    Ok(addresses)
}

fn remote_image_client(url: &Url, addresses: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    let builder = reqwest::Client::builder().redirect(Policy::none());
    let builder = if host.parse::<IpAddr>().is_ok() {
        builder
    } else {
        // Pin public addresses to prevent a second DNS resolution to a private destination.
        // Configured HTTP(S) proxies are trusted to apply their own destination policy.
        builder.resolve_to_addrs(host, addresses)
    };
    builder
        .build()
        .map_err(|error| format!("Unable to prepare avatar image request: {error}"))
}

async fn request_public_remote_image(mut url: Url) -> Result<Response, String> {
    for redirect_count in 0..=MAX_REMOTE_IMAGE_REDIRECTS {
        let addresses = resolve_public_remote_image_addrs(&url).await?;
        let client = remote_image_client(&url, &addresses)?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("Unable to load avatar image: {error}"))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REMOTE_IMAGE_REDIRECTS {
                return Err("Avatar image redirected too many times.".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Avatar image redirect is missing a valid location.".to_string())?;
            let next_url = url
                .join(location)
                .map_err(|_| "Avatar image redirect URL is invalid.".to_string())?;
            url = validated_remote_image_url(next_url.as_str())?;
            continue;
        }

        return response
            .error_for_status()
            .map_err(|error| format!("Unable to load avatar image: {error}"));
    }

    Err("Avatar image redirected too many times.".to_string())
}

async fn collect_bounded_remote_image_stream<S, B, E>(
    stream: S,
    max_bytes: usize,
) -> Result<Vec<u8>, String>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: Display,
{
    pin_mut!(stream);
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Unable to read avatar image: {error}"))?;
        let chunk = chunk.as_ref();
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            return Err("Avatar image is larger than 2 MB.".to_string());
        }
        bytes.extend_from_slice(chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn desktop_fetch_remote_image_data_url(url: String) -> Result<String, String> {
    let url = validated_remote_image_url(&url)?;
    let normalized_url = url.as_str().to_string();
    let cache_dir = active_remote_image_cache_dir();
    if let Some(cache_dir) = cache_dir.clone() {
        let cache_url = normalized_url.clone();
        if let Ok(Some(payload)) = tokio::task::spawn_blocking(move || {
            read_cached_remote_image(&cache_dir, &cache_url, unix_timestamp_seconds())
        })
        .await
        {
            return remote_image_data_url(&payload.media_type, &payload.bytes);
        }
    }

    let payload = tokio::time::timeout(REMOTE_IMAGE_TIMEOUT, async move {
        let response = request_public_remote_image(url).await?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_REMOTE_IMAGE_BYTES as u64)
        {
            return Err("Avatar image is larger than 2 MB.".to_string());
        }
        let media_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(supported_image_media_type)
            .ok_or_else(|| "Avatar URL did not return a supported image.".to_string())?;
        let bytes =
            collect_bounded_remote_image_stream(response.bytes_stream(), MAX_REMOTE_IMAGE_BYTES)
                .await?;
        Ok::<RemoteImagePayload, String>(RemoteImagePayload {
            media_type: media_type.to_string(),
            bytes,
        })
    })
    .await
    .map_err(|_| "Avatar image request timed out.".to_string())??;

    let data_url = remote_image_data_url(&payload.media_type, &payload.bytes)?;
    if let Some(cache_dir) = cache_dir {
        let cache_url = normalized_url;
        let cache_payload = payload;
        let _ = tokio::task::spawn_blocking(move || {
            write_cached_remote_image(
                &cache_dir,
                &cache_url,
                &cache_payload.media_type,
                &cache_payload.bytes,
                unix_timestamp_seconds(),
            )
        })
        .await;
    }
    Ok(data_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn avatar_cache_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kordi-avatar-cache-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn remote_avatar_urls_require_public_https_hosts() {
        assert!(validated_remote_image_url("https://images.example/avatar.png").is_ok());
        assert!(validated_remote_image_url("http://images.example/avatar.png").is_err());
        assert!(validated_remote_image_url("https://localhost/avatar.png").is_err());
        assert!(validated_remote_image_url("https://127.0.0.1/avatar.png").is_err());
        assert!(validated_remote_image_url("https://192.168.1.20/avatar.png").is_err());
    }

    #[test]
    fn remote_avatar_data_urls_are_bounded_and_typed() {
        assert_eq!(
            remote_image_data_url("image/png", b"avatar").expect("encode avatar"),
            "data:image/png;base64,YXZhdGFy"
        );
        assert!(remote_image_data_url("image/png", &[]).is_err());
        assert_eq!(
            supported_image_media_type("image/jpeg; charset=binary"),
            Some("image/jpeg")
        );
        let icon_type = supported_image_media_type("image/vnd.microsoft.icon");
        assert_eq!(icon_type, Some("image/x-icon"));
        assert_eq!(supported_image_media_type("image/svg+xml"), None);
    }

    #[test]
    fn remote_avatar_ip_filter_rejects_non_public_and_mapped_addresses() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "192.168.1.20",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b:1::7f00:1",
            "2001:2::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            let address = value.parse::<IpAddr>().expect("test IP address");
            assert!(!is_public_remote_ip(address), "{value} must not be public");
        }

        for value in [
            "1.1.1.1",
            "8.8.8.8",
            "64:ff9b::101:101",
            "2606:4700:4700::1111",
        ] {
            let address = value.parse::<IpAddr>().expect("test IP address");
            assert!(is_public_remote_ip(address), "{value} should remain public");
        }
    }

    #[tokio::test]
    async fn remote_avatar_stream_stops_before_exceeding_the_byte_limit() {
        use futures_util::stream;

        let accepted = stream::iter(vec![
            Ok::<Vec<u8>, std::io::Error>(vec![1; 8]),
            Ok::<Vec<u8>, std::io::Error>(vec![2; 4]),
        ]);
        assert_eq!(
            collect_bounded_remote_image_stream(accepted, 12)
                .await
                .expect("bounded body"),
            [vec![1; 8], vec![2; 4]].concat(),
        );

        let oversized = stream::iter(vec![
            Ok::<Vec<u8>, std::io::Error>(vec![1; 8]),
            Ok::<Vec<u8>, std::io::Error>(vec![2; 5]),
        ]);
        let error = collect_bounded_remote_image_stream(oversized, 12)
            .await
            .expect_err("oversized body should stop before buffering the next chunk");
        assert_eq!(error, "Avatar image is larger than 2 MB.");
    }

    #[test]
    fn validated_avatar_cache_survives_a_new_loader_instance() {
        let cache_dir = avatar_cache_test_dir("roundtrip");
        let url = "https://images.example/profile.png";
        let now = 1_750_000_000;
        write_cached_remote_image(&cache_dir, url, "image/png", b"avatar", now)
            .expect("write avatar cache");

        let payload = read_cached_remote_image(&cache_dir, url, now + 1)
            .expect("read avatar after simulated relaunch");
        assert_eq!(payload.media_type, "image/png");
        assert_eq!(payload.bytes, b"avatar");

        let encoded = std::fs::read(remote_image_cache_entry_path(&cache_dir, url))
            .expect("encoded cache entry");
        assert!(
            !String::from_utf8_lossy(&encoded).contains(url),
            "cache metadata must not persist the source URL or query string"
        );
        let _ = std::fs::remove_dir_all(cache_dir);
    }

    #[test]
    fn avatar_cache_paths_are_scoped_by_account_storage_root() {
        let alpha = remote_image_cache_dir("/app-data/accounts/alpha/kordi");
        let beta = remote_image_cache_dir("/app-data/accounts/beta/kordi");

        assert_ne!(alpha, beta);
        assert!(alpha.ends_with("accounts/alpha/kordi/cache/remote-avatars-v1"));
        assert!(beta.ends_with("accounts/beta/kordi/cache/remote-avatars-v1"));
    }

    #[test]
    fn corrupted_or_expired_avatar_cache_entries_are_removed() {
        let cache_dir = avatar_cache_test_dir("invalid");
        std::fs::create_dir_all(&cache_dir).expect("create cache directory");
        let corrupt_url = "https://images.example/corrupt.png";
        let corrupt_path = remote_image_cache_entry_path(&cache_dir, corrupt_url);
        std::fs::write(&corrupt_path, b"not-a-cache-entry").expect("write corrupt entry");
        assert!(read_cached_remote_image(&cache_dir, corrupt_url, 1_750_000_000).is_none());
        assert!(!corrupt_path.exists());

        let stale_url = "https://images.example/stale.png";
        write_cached_remote_image(&cache_dir, stale_url, "image/webp", b"stale", 1)
            .expect("write stale entry");
        let stale_path = remote_image_cache_entry_path(&cache_dir, stale_url);
        assert!(read_cached_remote_image(
            &cache_dir,
            stale_url,
            REMOTE_IMAGE_CACHE_TTL.as_secs() + 2,
        )
        .is_none());
        assert!(!stale_path.exists());
        let _ = std::fs::remove_dir_all(cache_dir);
    }

    #[test]
    fn avatar_disk_cache_pruning_is_explicitly_bounded() {
        let cache_dir = avatar_cache_test_dir("bounded");
        std::fs::create_dir_all(&cache_dir).expect("create cache directory");
        for index in 0..5 {
            std::fs::write(
                cache_dir.join(format!("entry-{index}.{REMOTE_IMAGE_CACHE_EXTENSION}")),
                vec![index as u8; 16],
            )
            .expect("write cache fixture");
        }
        let abandoned_temporary = cache_dir.join(".abandoned.tmp");
        std::fs::write(&abandoned_temporary, vec![0_u8; 16])
            .expect("write abandoned cache fixture");

        prune_remote_image_cache(&cache_dir, 2, 32).expect("prune avatar cache");
        let entries = std::fs::read_dir(&cache_dir)
            .expect("read cache directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str())
                    == Some(REMOTE_IMAGE_CACHE_EXTENSION)
            })
            .count();
        assert_eq!(entries, 2);
        assert!(!abandoned_temporary.exists());
        let _ = std::fs::remove_dir_all(cache_dir);
    }
}
