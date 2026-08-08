mod agent;
mod config;
mod mailer;
mod routes;
mod tickets;

use std::sync::Arc;

pub use agent::{bootstrap_support_agent, message_targets_support_agent, support_contact};
pub use config::{PendingSupportConfig, SupportConfig, SupportConfigError, SupportProviderAuth};
pub use routes::routes;

use mailer::SupportMailer;

#[derive(Clone)]
pub struct SupportService {
    config: SupportConfig,
    mailer: Option<Arc<SupportMailer>>,
}

impl SupportService {
    pub fn new(config: SupportConfig) -> Self {
        let mailer = SupportMailer::from_env(&config).map(Arc::new);
        Self { config, mailer }
    }

    pub fn config(&self) -> &SupportConfig {
        &self.config
    }

    pub fn mail_delivery_enabled(&self) -> bool {
        self.mailer.is_some()
    }

    pub async fn deliver_ticket(&self, pool: &sqlx_postgres::PgPool, ticket_id: &str) {
        let Some(mailer) = self.mailer.as_ref() else {
            return;
        };
        if let Err(error) = tickets::deliver_ticket(pool, mailer, Some(ticket_id)).await {
            eprintln!("[support] deliver ticket {ticket_id}: {error}");
        }
    }
}

pub fn spawn_ticket_worker(state: Arc<crate::server::ServerState>) {
    let Some(service) = state.support().cloned() else {
        return;
    };
    if !service.mail_delivery_enabled() {
        println!("Kordi support tickets are durable; email delivery is disabled until SMTP is configured");
        return;
    }

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            for _ in 0..10 {
                let delivered = match tickets::deliver_ticket(
                    state.db_pool(),
                    service.mailer.as_ref().expect("mailer checked above"),
                    None,
                )
                .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("[support] ticket delivery worker: {error}");
                        break;
                    }
                };
                if !delivered {
                    break;
                }
            }
        }
    });
}
