//! Registered apps that may use browser sign-in, and their redirect URIs.
//!
//! Every app is a public client: it has a client ID but no secret, and PKCE
//! binds the code to the app instance that started the sign-in. Redirect URIs
//! match exactly, except that a loopback redirect registered without a port
//! accepts any port (RFC 8252, section 7.3).

use serde::Deserialize;

/// Server configuration that replaces the built-in client list. A JSON array
/// of `{"clientId", "name", "redirectUris"}` objects.
pub const APP_CLIENTS_ENV: &str = "KORDI_AUTH_APP_CLIENTS";

const MAX_REDIRECT_URI_CHARS: usize = 2048;
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "[::1]"];

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct AppClient {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub name: String,
    #[serde(rename = "redirectUris")]
    pub redirect_uris: Vec<String>,
}

impl AppClient {
    /// Whether `requested` is one of this client's redirect URIs.
    pub fn allows_redirect_uri(&self, requested: &str) -> bool {
        self.redirect_uris
            .iter()
            .any(|registered| redirect_uri_matches(registered, requested))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppClientRegistry {
    clients: Vec<AppClient>,
}

impl AppClientRegistry {
    /// The Kordi apps every server knows by default. Release, Beta and
    /// staging builds each have their own client ID and callback scheme.
    pub fn builtin() -> Self {
        let desktop = |client_id: &str, name: &str, scheme: &str| AppClient {
            client_id: client_id.to_string(),
            name: name.to_string(),
            redirect_uris: vec![
                "http://127.0.0.1/auth/callback".to_string(),
                "http://[::1]/auth/callback".to_string(),
                format!("{scheme}://auth/callback"),
            ],
        };
        let ios = |client_id: &str, name: &str, scheme: &str| AppClient {
            client_id: client_id.to_string(),
            name: name.to_string(),
            redirect_uris: vec![format!("{scheme}://auth/callback")],
        };
        Self {
            clients: vec![
                desktop("kordi-desktop", "Kordi for Mac", "kordi"),
                ios("kordi-ios", "Kordi for iPhone", "kordi"),
                desktop("kordi-desktop-beta", "Kordi Beta for Mac", "kordi-beta"),
                ios("kordi-ios-beta", "Kordi Beta for iPhone", "kordi-beta"),
                desktop(
                    "kordi-desktop-staging",
                    "Kordi Staging for Mac",
                    "kordi-staging",
                ),
                ios(
                    "kordi-ios-staging",
                    "Kordi Staging for iPhone",
                    "kordi-staging",
                ),
            ],
        }
    }

    /// Parse and validate a configured client list.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let clients: Vec<AppClient> =
            serde_json::from_slice(json.as_bytes()).map_err(|error| error.to_string())?;
        let mut seen = std::collections::HashSet::new();
        for client in &clients {
            let id = client.client_id.trim();
            if id.is_empty() || id != client.client_id || id.len() > 64 {
                return Err(format!("invalid client ID {:?}", client.client_id));
            }
            if !seen.insert(id.to_string()) {
                return Err(format!("duplicate client ID {id}"));
            }
            if client.redirect_uris.is_empty() {
                return Err(format!("client {id} has no redirect URIs"));
            }
            for uri in &client.redirect_uris {
                validate_registered_redirect_uri(uri)
                    .map_err(|reason| format!("client {id} redirect URI {uri:?}: {reason}"))?;
            }
        }
        Ok(Self { clients })
    }

    /// The configured list, or the built-in list when nothing is configured.
    /// An invalid configuration registers no clients, so browser sign-in
    /// fails closed instead of trusting a list it could not read.
    pub fn from_env() -> Self {
        match std::env::var(APP_CLIENTS_ENV) {
            Ok(value) if !value.trim().is_empty() => Self::from_json(&value).unwrap_or_else(|error| {
                eprintln!("[auth] ignoring invalid {APP_CLIENTS_ENV}: {error}; browser sign-in is disabled");
                Self { clients: Vec::new() }
            }),
            _ => Self::builtin(),
        }
    }

    pub fn client(&self, client_id: &str) -> Option<&AppClient> {
        self.clients
            .iter()
            .find(|client| client.client_id == client_id)
    }
}

fn validate_registered_redirect_uri(uri: &str) -> Result<(), &'static str> {
    if uri.len() > MAX_REDIRECT_URI_CHARS || uri.trim() != uri {
        return Err("is too long or has surrounding spaces");
    }
    let url = url::Url::parse(uri).map_err(|_| "is not an absolute URI")?;
    if url.fragment().is_some() || uri.contains('#') {
        return Err("must not have a fragment");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not have user information");
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if loopback_host(&url).is_some() => Ok(()),
        "http" => Err("plain HTTP is only allowed for loopback addresses"),
        scheme if scheme.len() > 2 => Ok(()),
        _ => Err("has an unsupported scheme"),
    }
}

/// The literal loopback host of an `http` URL, if it has one. `localhost`
/// is deliberately not accepted (RFC 8252, section 8.3).
fn loopback_host(url: &url::Url) -> Option<&'static str> {
    if url.scheme() != "http" {
        return None;
    }
    let host = match url.host()? {
        url::Host::Ipv4(address) => address.to_string(),
        url::Host::Ipv6(address) => format!("[{address}]"),
        url::Host::Domain(_) => return None,
    };
    LOOPBACK_HOSTS
        .into_iter()
        .find(|loopback| *loopback == host)
}

/// Whether a requested redirect URI matches a registered one. The comparison
/// is on the exact strings. The only exception is a loopback registration
/// without a port, which matches the same URI with any explicit port.
pub fn redirect_uri_matches(registered: &str, requested: &str) -> bool {
    if requested.is_empty() || requested.len() > MAX_REDIRECT_URI_CHARS || requested.contains('#') {
        return false;
    }
    if registered == requested {
        return true;
    }
    let Ok(registered_url) = url::Url::parse(registered) else {
        return false;
    };
    let Some(host) = loopback_host(&registered_url) else {
        return false;
    };
    if registered_url.port().is_some() {
        return false;
    }
    let Ok(requested_url) = url::Url::parse(requested) else {
        return false;
    };
    let Some(port) = requested_url.port() else {
        return false;
    };
    if port == 0 {
        return false;
    }
    let suffix = &registered[format!("http://{host}").len()..];
    requested == format!("http://{host}:{port}{suffix}")
}

#[cfg(test)]
mod tests;
