use lettre::message::{Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use super::config::SupportConfig;
use super::tickets::SupportTicketForDelivery;

#[derive(Clone)]
pub struct SupportMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    inbox: Mailbox,
}

impl SupportMailer {
    pub fn from_env(config: &SupportConfig) -> Option<Self> {
        let host = env_value("KORDI_SUPPORT_SMTP_HOST")?;
        let username = env_value("KORDI_SUPPORT_SMTP_USERNAME")?;
        let password = env_value("KORDI_SUPPORT_SMTP_PASSWORD")?;
        let port = env_value("KORDI_SUPPORT_SMTP_PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(587);
        let from = env_value("KORDI_SUPPORT_SMTP_FROM")
            .unwrap_or_else(|| username.clone())
            .parse::<Mailbox>()
            .ok()?;
        let inbox = config.inbox.parse::<Mailbox>().ok()?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            .ok()?
            .port(port)
            .credentials(Credentials::new(username, password))
            .build();
        Some(Self {
            transport,
            from,
            inbox,
        })
    }

    pub async fn send(&self, ticket: &SupportTicketForDelivery) -> Result<(), String> {
        let category = ticket.category.to_ascii_uppercase();
        let subject = format!(
            "[Kordi {category}] {} ({})",
            ticket.subject, ticket.ticket_id
        );
        let body = format!(
            "Kordi support request\n\nTicket: {}\nCategory: {}\nAccount: {}\nUser: {}\nEmail: {}\nSession: {}\nCreated: {}\n\n{}\n\nDiagnostics:\n{}",
            ticket.ticket_id,
            ticket.category,
            ticket.account_id,
            ticket.display_name.as_deref().unwrap_or("Not provided"),
            ticket.primary_email.as_deref().unwrap_or("Not provided"),
            ticket.session_id.as_deref().unwrap_or("Not provided"),
            ticket.created_at,
            ticket.description,
            serde_json::to_string_pretty(&ticket.diagnostics).unwrap_or_else(|_| "{}".into()),
        );
        let message = Message::builder()
            .from(self.from.clone())
            .to(self.inbox.clone())
            .subject(subject)
            .body(body)
            .map_err(|error| error.to_string())?;
        self.transport
            .send(message)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
