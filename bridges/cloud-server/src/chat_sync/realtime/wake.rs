use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx_postgres::PgListener;
use tokio::sync::{broadcast, watch};

use crate::auth::session_signals::{SessionSignal, SessionSignalHub, SESSION_SIGNAL_CHANNEL};

const WAKE_CHANNEL: &str = "chat_sync_events";

/// Whether this replica's notification listener is connected. `epoch` grows
/// on every successful (re)connect, so sockets can catch up on anything a
/// disconnected listener may have missed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ListenerStatus {
    pub(crate) connected: bool,
    pub(crate) epoch: u64,
}

pub(crate) struct ChatSyncWakeHub {
    accounts: Mutex<HashMap<String, broadcast::Sender<()>>>,
    status: watch::Sender<ListenerStatus>,
}

impl ChatSyncWakeHub {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
            status: watch::channel(ListenerStatus::default()).0,
        })
    }

    /// The listener status, for sockets that adapt their backstop polling.
    pub(crate) fn listener_status(&self) -> watch::Receiver<ListenerStatus> {
        self.status.subscribe()
    }

    pub(super) fn set_listener_connected(&self, connected: bool) {
        self.status.send_modify(|status| {
            if connected && !status.connected {
                status.epoch += 1;
            }
            status.connected = connected;
        });
    }

    pub(super) fn subscribe(self: &Arc<Self>, account_id: &str) -> ChatSyncWakeSubscription {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sender = accounts
            .entry(account_id.to_string())
            .or_insert_with(|| broadcast::channel(16).0);
        ChatSyncWakeSubscription {
            account_id: account_id.to_string(),
            receiver: sender.subscribe(),
            hub: self.clone(),
        }
    }

    pub(super) fn wake(&self, account_id: &str) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if accounts
            .get(account_id)
            .is_some_and(|sender| sender.send(()).is_err())
        {
            accounts.remove(account_id);
        }
    }

    /// Called while the dropping subscription's own receiver still counts.
    fn release(&self, account_id: &str) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if accounts
            .get(account_id)
            .is_some_and(|sender| sender.receiver_count() <= 1)
        {
            accounts.remove(account_id);
        }
    }
}

pub(super) struct ChatSyncWakeSubscription {
    account_id: String,
    pub(super) receiver: broadcast::Receiver<()>,
    hub: Arc<ChatSyncWakeHub>,
}

impl ChatSyncWakeSubscription {
    pub(super) async fn recv(&mut self) {
        let _ = self.receiver.recv().await;
    }
}

impl Drop for ChatSyncWakeSubscription {
    fn drop(&mut self) {
        self.hub.release(&self.account_id);
    }
}

/// Starts this replica's single notification listener: chat sync wakes and
/// session revocation signals share one PostgreSQL connection.
pub(crate) fn spawn_wake_listener(
    database_url: String,
    hub: Arc<ChatSyncWakeHub>,
    sessions: Arc<SessionSignalHub>,
) {
    tokio::spawn(async move {
        loop {
            let result: Result<(), sqlx_core::Error> = async {
                let mut listener = PgListener::connect(&database_url).await?;
                listener
                    .listen_all([WAKE_CHANNEL, SESSION_SIGNAL_CHANNEL])
                    .await?;
                hub.set_listener_connected(true);
                // `try_recv` reports a lost connection instead of silently
                // reconnecting, so the status (and the catch-up it drives)
                // follows every gap in which notifications may be lost.
                while let Some(notification) = listener.try_recv().await? {
                    let payload = notification.payload().trim();
                    if notification.channel() == SESSION_SIGNAL_CHANNEL {
                        if let Some(signal) = SessionSignal::parse(payload) {
                            sessions.publish(signal);
                        }
                    } else if !payload.is_empty() {
                        hub.wake(payload);
                    }
                }
                Ok(())
            }
            .await;
            hub.set_listener_connected(false);
            match result {
                Ok(()) => eprintln!("[chat-realtime] notification listener: connection lost"),
                Err(error) => eprintln!("[chat-realtime] notification listener: {error}"),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
