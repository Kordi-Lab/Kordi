use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx_postgres::PgListener;
use tokio::sync::broadcast;

pub(crate) struct ChatSyncWakeHub {
    accounts: Mutex<HashMap<String, broadcast::Sender<()>>>,
}

impl ChatSyncWakeHub {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
        })
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

    fn release(&self, account_id: &str) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if accounts
            .get(account_id)
            .is_some_and(|sender| sender.receiver_count() == 0)
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

pub(crate) fn spawn_wake_listener(database_url: String, hub: Arc<ChatSyncWakeHub>) {
    tokio::spawn(async move {
        loop {
            let result: Result<(), sqlx_core::Error> = async {
                let mut listener = PgListener::connect(&database_url).await?;
                listener.listen("chat_sync_events").await?;
                loop {
                    let notification = listener.recv().await?;
                    let account_id = notification.payload().trim();
                    if !account_id.is_empty() {
                        hub.wake(account_id);
                    }
                }
            }
            .await;
            if let Err(error) = result {
                eprintln!("[chat-realtime] notification listener: {error}");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });
}
