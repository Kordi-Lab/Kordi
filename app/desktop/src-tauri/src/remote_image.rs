use std::{
    fmt::Display,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use futures_util::{pin_mut, Stream, StreamExt};
use reqwest::{
    header::{CONTENT_TYPE, LOCATION},
    redirect::Policy,
    Response, Url,
};

mod cache;
use cache::{
    active_remote_image_cache_dir, read_cached_remote_image, remote_image_data_url, sha256_hex,
    supported_image_media_type, unix_timestamp_seconds, write_cached_remote_image,
    RemoteImageCachePolicy, RemoteImagePayload, AVATAR_CACHE_POLICY, BLOB_EMOJI_CACHE_POLICY,
    MAX_REMOTE_IMAGE_BYTES,
};

const MAX_REMOTE_IMAGE_REDIRECTS: usize = 3;
const REMOTE_IMAGE_TIMEOUT: Duration = Duration::from_secs(15);

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

pub(crate) fn validated_remote_image_url(value: &str) -> Result<Url, String> {
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

fn validated_remote_image_url_for_policy(
    value: &str,
    policy: &RemoteImageCachePolicy,
) -> Result<(Url, bool), String> {
    if cfg!(debug_assertions) && policy.allow_debug_loopback {
        if let Ok(url) = Url::parse(value.trim()) {
            let loopback = url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none();
            if loopback {
                return Ok((url, true));
            }
        }
    }
    validated_remote_image_url(value).map(|url| (url, false))
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

pub(crate) async fn request_public_remote_image(mut url: Url) -> Result<Response, String> {
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

async fn request_debug_loopback_image(url: Url) -> Result<Response, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Unable to prepare debug image request: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Unable to load debug image: {error}"))?;
    if response.status().is_redirection() {
        return Err("Debug image redirects are not allowed.".to_string());
    }
    response
        .error_for_status()
        .map_err(|error| format!("Unable to load debug image: {error}"))
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

fn validated_expected_sha256(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Remote image SHA-256 is invalid.".to_string());
    }
    Ok(value)
}

async fn fetch_remote_image_data_url(
    url: String,
    expected_sha256: Option<String>,
    policy: &'static RemoteImageCachePolicy,
) -> Result<String, String> {
    let (url, debug_loopback) = validated_remote_image_url_for_policy(&url, policy)?;
    let expected_sha256 = expected_sha256
        .as_deref()
        .map(validated_expected_sha256)
        .transpose()?;
    let normalized_url = url.as_str().to_string();
    let cache_dir = active_remote_image_cache_dir(policy);
    if let Some(cache_dir) = cache_dir.clone() {
        let cache_url = normalized_url.clone();
        let cache_expected_sha256 = expected_sha256.clone();
        if let Ok(Some(payload)) = tokio::task::spawn_blocking(move || {
            read_cached_remote_image(
                &cache_dir,
                &cache_url,
                unix_timestamp_seconds(),
                cache_expected_sha256.as_deref(),
                policy,
            )
        })
        .await
        {
            return remote_image_data_url(&payload.media_type, &payload.bytes);
        }
    }

    let payload = tokio::time::timeout(REMOTE_IMAGE_TIMEOUT, async move {
        let response = if debug_loopback {
            request_debug_loopback_image(url).await?
        } else {
            request_public_remote_image(url).await?
        };
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
        if policy
            .required_media_type
            .is_some_and(|required| required != media_type)
        {
            return Err("Remote image response type did not match the catalog.".to_string());
        }
        let bytes =
            collect_bounded_remote_image_stream(response.bytes_stream(), MAX_REMOTE_IMAGE_BYTES)
                .await?;
        if expected_sha256
            .as_deref()
            .is_some_and(|expected| expected != sha256_hex(&bytes))
        {
            return Err("Remote image response failed integrity validation.".to_string());
        }
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
                policy,
            )
        })
        .await;
    }
    Ok(data_url)
}

#[tauri::command]
pub async fn desktop_fetch_remote_image_data_url(url: String) -> Result<String, String> {
    fetch_remote_image_data_url(url, None, &AVATAR_CACHE_POLICY).await
}

#[tauri::command]
pub async fn desktop_fetch_blob_emoji_data_url(
    url: String,
    expected_sha256: String,
) -> Result<String, String> {
    fetch_remote_image_data_url(url, Some(expected_sha256), &BLOB_EMOJI_CACHE_POLICY).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_avatar_urls_require_public_https_hosts() {
        assert!(validated_remote_image_url("https://images.example/avatar.png").is_ok());
        assert!(validated_remote_image_url("http://images.example/avatar.png").is_err());
        assert!(validated_remote_image_url("https://localhost/avatar.png").is_err());
        assert!(validated_remote_image_url("https://127.0.0.1/avatar.png").is_err());
        assert!(validated_remote_image_url("https://192.168.1.20/avatar.png").is_err());
    }

    #[test]
    fn blob_emoji_debug_cache_accepts_only_literal_loopback_http() {
        assert!(validated_remote_image_url_for_policy(
            "http://127.0.0.1:17185/assets/blob.webp",
            &BLOB_EMOJI_CACHE_POLICY,
        )
        .is_ok_and(|(_, debug_loopback)| debug_loopback));
        for url in [
            "http://localhost:17185/assets/blob.webp",
            "http://192.168.1.20/assets/blob.webp",
            "http://127.0.0.1@example.test/assets/blob.webp",
        ] {
            assert!(validated_remote_image_url_for_policy(url, &BLOB_EMOJI_CACHE_POLICY).is_err());
        }
        assert!(validated_remote_image_url_for_policy(
            "http://127.0.0.1:17185/assets/avatar.png",
            &AVATAR_CACHE_POLICY,
        )
        .is_err());
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
}
