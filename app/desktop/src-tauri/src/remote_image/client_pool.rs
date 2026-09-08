use std::{
    collections::VecDeque,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
};

use reqwest::{redirect::Policy, Url};

const MAX_REMOTE_IMAGE_CLIENTS: usize = 16;
type RemoteImageClientCache = VecDeque<(String, reqwest::Client)>;
static REMOTE_IMAGE_CLIENTS: OnceLock<Mutex<RemoteImageClientCache>> = OnceLock::new();

pub(super) fn remote_image_client(
    url: &Url,
    addresses: &[SocketAddr],
) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    // Some sites reject metadata and image requests without a User-Agent.
    let builder = reqwest::Client::builder()
        .user_agent(concat!("Kordi/", env!("CARGO_PKG_VERSION")))
        .redirect(Policy::none());
    let builder = if host.parse::<std::net::IpAddr>().is_ok() {
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

pub(super) fn pooled_remote_image_client(
    url: &Url,
    addresses: &[SocketAddr],
) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    let mut sorted_addresses = addresses.to_vec();
    sorted_addresses.sort_unstable();
    let key = format!(
        "{}://{}:{}:{sorted_addresses:?}",
        url.scheme(),
        host,
        url.port_or_known_default().unwrap_or_default(),
    );
    let cache = REMOTE_IMAGE_CLIENTS.get_or_init(|| Mutex::new(VecDeque::new()));
    let mut cache = cache
        .lock()
        .map_err(|_| "Unable to access the remote image connection pool.".to_string())?;
    if let Some(index) = cache.iter().position(|(cached_key, _)| cached_key == &key) {
        let entry = cache
            .remove(index)
            .expect("the cached remote image client index remains valid");
        let client = entry.1.clone();
        cache.push_back(entry);
        return Ok(client);
    }

    let client = remote_image_client(url, &sorted_addresses)?;
    if cache.len() >= MAX_REMOTE_IMAGE_CLIENTS {
        cache.pop_front();
    }
    cache.push_back((key, client.clone()));
    Ok(client)
}
