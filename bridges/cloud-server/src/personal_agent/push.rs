//! The push for a message the agent posted on its own. Evaluations finish
//! on the runner's completion path, which holds only the pool, and the Mac's
//! complete route sends no push for an evaluation, so the worker installs
//! the server's push service here at start. It is the normal message push;
//! its title is the agent's name, read from the message's `agentName`.
//! Without a push service (local stacks) it is skipped.

use std::sync::OnceLock;

use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::notifications::PushNotificationService;

static SERVICE: OnceLock<PushNotificationService> = OnceLock::new();

pub(super) fn install(service: Option<&PushNotificationService>) {
    if let Some(service) = service {
        let _ = SERVICE.set(service.clone());
    }
}

/// Sends the message push for `message_id` in the background. Best effort.
pub(super) fn message(pool: &PgPool, message_id: Uuid) {
    let Some(service) = SERVICE.get().cloned() else {
        return;
    };
    let pool = pool.clone();
    tokio::spawn(async move {
        match crate::chat_sync::store::load_message_snapshot(&pool, message_id).await {
            Ok(message) => service.send_message_attention(&pool, &message).await,
            Err(error) => {
                eprintln!("[personal_agent] Could not load {message_id} for its push: {error}")
            }
        }
    });
}
