use std::net::IpAddr;
use std::time::Duration;

use lettre::message::{Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use super::*;

/// How the signup mailer protects its SMTP connection (`KORDI_AUTH_SMTP_SECURITY`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SmtpSecurity {
    /// Upgrade the connection with STARTTLS before authenticating (default).
    StartTls,
    /// Implicit TLS from the first byte.
    Tls,
    /// Plaintext without authentication, for a development mail catcher only.
    None,
}

impl SmtpSecurity {
    pub(super) fn parse(value: Option<&str>) -> Result<Self, &'static str> {
        let value = value.map(str::trim).unwrap_or_default();
        if value.is_empty() || value.eq_ignore_ascii_case("starttls") {
            Ok(Self::StartTls)
        } else if value.eq_ignore_ascii_case("tls") {
            Ok(Self::Tls)
        } else if value.eq_ignore_ascii_case("none") {
            Ok(Self::None)
        } else {
            Err("KORDI_AUTH_SMTP_SECURITY must be starttls, tls, or none")
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::StartTls => 587,
            Self::Tls => 465,
            Self::None => 25,
        }
    }
}

/// Plaintext SMTP is accepted only by a development build, only toward a
/// loopback, private-network, or single-label (Compose service) host, and
/// never with credentials.
pub(super) fn check_plaintext_allowed(
    host: &str,
    development_build: bool,
    has_credentials: bool,
) -> Result<(), &'static str> {
    if !development_build {
        return Err("KORDI_AUTH_SMTP_SECURITY=none is available only in development builds; use starttls or tls");
    }
    if !is_private_mail_host(host) {
        return Err("KORDI_AUTH_SMTP_SECURITY=none requires a loopback, private-network, or Compose service host");
    }
    if has_credentials {
        return Err("KORDI_AUTH_SMTP_SECURITY=none never sends credentials; unset KORDI_AUTH_SMTP_USERNAME and KORDI_AUTH_SMTP_PASSWORD");
    }
    Ok(())
}

fn is_private_mail_host(host: &str) -> bool {
    let bare = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            // Loopback or unique local (fc00::/7).
            IpAddr::V6(ip) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        };
    }
    let name = host.to_ascii_lowercase();
    // A label must start with a letter so numeric forms such as `2130706433`
    // or `0x7f000001`, which resolvers may read as IPv4 addresses, never pass.
    let valid_label = |label: &str| {
        label.len() <= 63
            && label.starts_with(|c: char| c.is_ascii_alphabetic())
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if name == "localhost" || name.ends_with(".localhost") {
        return name.split('.').all(valid_label);
    }
    !name.contains('.') && valid_label(&name)
}

pub(super) struct SmtpSignupCodeSender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    host: String,
}

impl SmtpSignupCodeSender {
    /// `Ok(None)` while delivery is not configured; `Err` when the configured
    /// connection security is invalid or refused for this build and host.
    pub(super) fn from_env() -> Result<Option<Self>, &'static str> {
        Self::from_settings(env_value, crate::distribution::development_build())
    }

    /// Builds the sender from `KORDI_AUTH_SMTP_*` values read through `get`.
    pub(super) fn from_settings(
        get: impl Fn(&str) -> Option<String>,
        development_build: bool,
    ) -> Result<Option<Self>, &'static str> {
        let security = SmtpSecurity::parse(get("KORDI_AUTH_SMTP_SECURITY").as_deref())?;
        let Some(host) = get("KORDI_AUTH_SMTP_HOST") else {
            return Ok(None);
        };
        let username = get("KORDI_AUTH_SMTP_USERNAME");
        let password = get("KORDI_AUTH_SMTP_PASSWORD");
        if security == SmtpSecurity::None {
            check_plaintext_allowed(
                &host,
                development_build,
                username.is_some() || password.is_some(),
            )?;
        }
        let port = match get("KORDI_AUTH_SMTP_PORT") {
            Some(value) => match value.parse::<u16>() {
                Ok(port) => port,
                Err(_) => return Ok(None),
            },
            None => security.default_port(),
        };
        let Some(from) = get("KORDI_AUTH_SMTP_FROM").and_then(|v| v.parse::<Mailbox>().ok()) else {
            return Ok(None);
        };
        let builder = match security {
            SmtpSecurity::StartTls | SmtpSecurity::Tls => {
                let (Some(username), Some(password)) = (username, password) else {
                    return Ok(None);
                };
                let relay = if security == SmtpSecurity::StartTls {
                    AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
                } else {
                    AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
                };
                let Ok(relay) = relay else {
                    return Ok(None);
                };
                relay.credentials(Credentials::new(username, password))
            }
            SmtpSecurity::None => {
                println!("Kordi signup email uses plaintext SMTP to development host {host}");
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
            }
        };
        let transport = builder
            .port(port)
            .timeout(Some(Duration::from_secs(8)))
            .build();
        Ok(Some(Self {
            transport,
            from,
            host,
        }))
    }
}

#[async_trait]
impl SignupCodeSender for SmtpSignupCodeSender {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        let message = Message::builder()
            .from(self.from.clone())
            .to(email.parse::<Mailbox>().map_err(|_| "Invalid recipient")?)
            .subject("Your Kordi verification code")
            .body(format!(
                "Your Kordi verification code is {code}.\n\nIt expires in 10 minutes. Enter it in Kordi to create your account.\n\nIf you did not request this code, ignore this email. Never share this code."
            ))
            .map_err(|_| "Could not prepare verification email")?;
        // Complete before the desktop client's 15-second request timeout.
        tokio::time::timeout(Duration::from_secs(10), self.transport.send(message))
            .await
            .map_err(|_| {
                eprintln!("[auth] signup email delivery via {} timed out", self.host);
                "Verification email delivery timed out"
            })?
            .map(|_| ())
            .map_err(|error| {
                eprintln!(
                    "[auth] signup email delivery via {} failed: {error}",
                    self.host
                );
                "Could not deliver verification email"
            })
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "smtp_tests.rs"]
mod tests;
