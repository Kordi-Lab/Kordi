use std::time::Duration;

use lettre::message::{Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use super::*;

pub(super) struct SmtpSignupCodeSender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpSignupCodeSender {
    pub(super) fn from_env() -> Option<Self> {
        let host = env_value("KORDI_AUTH_SMTP_HOST")?;
        let username = env_value("KORDI_AUTH_SMTP_USERNAME")?;
        let password = env_value("KORDI_AUTH_SMTP_PASSWORD")?;
        let port = match env_value("KORDI_AUTH_SMTP_PORT") {
            Some(value) => value.parse::<u16>().ok()?,
            None => 587,
        };
        let from = env_value("KORDI_AUTH_SMTP_FROM")?.parse::<Mailbox>().ok()?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            .ok()?
            .port(port)
            .timeout(Some(Duration::from_secs(8)))
            .credentials(Credentials::new(username, password))
            .build();
        Some(Self { transport, from })
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
            .map_err(|_| "Verification email delivery timed out")?
            .map(|_| ())
            .map_err(|_| "Could not deliver verification email")
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
