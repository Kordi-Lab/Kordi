use std::{net::IpAddr, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header::CONTENT_TYPE, redirect::Policy, Url};

const MAX_REMOTE_IMAGE_BYTES: u64 = 2 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT: Duration = Duration::from_secs(15);

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
        let is_private = match address {
            IpAddr::V4(address) => {
                address.is_private()
                    || address.is_loopback()
                    || address.is_link_local()
                    || address.is_unspecified()
            }
            IpAddr::V6(address) => {
                address.is_loopback()
                    || address.is_unique_local()
                    || address.is_unicast_link_local()
                    || address.is_unspecified()
            }
        };
        if is_private {
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
        _ => None,
    }
}

fn remote_image_data_url(media_type: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Avatar image response was empty.".to_string());
    }
    if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
        return Err("Avatar image is larger than 2 MB.".to_string());
    }
    Ok(format!(
        "data:{media_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn remote_image_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= 3 {
            return attempt.error("too many avatar image redirects");
        }
        match validated_remote_image_url(attempt.url().as_str()) {
            Ok(_) => attempt.follow(),
            Err(error) => attempt.error(std::io::Error::other(error)),
        }
    })
}

#[tauri::command]
pub async fn desktop_fetch_remote_image_data_url(url: String) -> Result<String, String> {
    let url = validated_remote_image_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(remote_image_redirect_policy())
        .timeout(REMOTE_IMAGE_TIMEOUT)
        .build()
        .map_err(|error| format!("Unable to prepare avatar image request: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Unable to load avatar image: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Unable to load avatar image: {error}"))?;

    validated_remote_image_url(response.url().as_str())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_IMAGE_BYTES)
    {
        return Err("Avatar image is larger than 2 MB.".to_string());
    }
    let media_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(supported_image_media_type)
        .ok_or_else(|| "Avatar URL did not return a supported image.".to_string())?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Unable to read avatar image: {error}"))?;
    remote_image_data_url(media_type, &bytes)
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
        assert_eq!(supported_image_media_type("image/svg+xml"), None);
    }
}
