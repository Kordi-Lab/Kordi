//! Process-wide wake-up fan-out for committed chat sync events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sqlx_postgres::{PgListener, PgPool};
use tokio::sync::broadcast;

const CHAT_SYNC_NOTIFICATION_CHANNEL: &str = "chat_sync_events";
const LISTENER_RECONNECT_DELAY: Duration = Duration::from_secs(1);

pub(crate) struct ChatSyncWakeHub {
    sender: broadcast::Sender<()>,
    listener_started: AtomicBool,
}

impl ChatSyncWakeHub {
    pub(crate) fn new() -> Self {
        let (sender, _) = broadcast::channel(64);
        Self {
            sender,
            listener_started: AtomicBool::new(false),
        }
    }

    pub(crate) fn subscribe(&self, pool: &PgPool) -> broadcast::Receiver<()> {
        let receiver = self.sender.subscribe();
        if self
            .listener_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let pool = pool.clone();
            let sender = self.sender.clone();
            tokio::spawn(async move {
                run_durable_wake_listener(pool, sender).await;
            });
        }
        receiver
    }
}

async fn run_durable_wake_listener(pool: PgPool, sender: broadcast::Sender<()>) {
    loop {
        if pool.is_closed() {
            return;
        }
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(listener) => listener,
            Err(_) => {
                tokio::time::sleep(LISTENER_RECONNECT_DELAY).await;
                continue;
            }
        };
        if listener
            .listen(CHAT_SYNC_NOTIFICATION_CHANNEL)
            .await
            .is_err()
        {
            tokio::time::sleep(LISTENER_RECONNECT_DELAY).await;
            continue;
        }

        // The listener may have been unavailable while transactions committed.
        // Wake every socket once after LISTEN so each account repairs from its
        // own durable cursor before relying on subsequent notifications.
        let _ = sender.send(());
        loop {
            match listener.try_recv().await {
                Ok(Some(_)) => {
                    let _ = sender.send(());
                }
                Ok(None) => {
                    // PgListener reconnected after a dropped connection. The
                    // notification itself may have been lost, so force readback.
                    let _ = sender.send(());
                }
                Err(_) => break,
            }
        }
        tokio::time::sleep(LISTENER_RECONNECT_DELAY).await;
    }
}
