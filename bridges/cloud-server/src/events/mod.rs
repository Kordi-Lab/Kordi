//! Cloud-server event bus.
//!
//! Wraps a JetStream context so the server can publish lifecycle events
//! (signup, contact-add, message-create) onto the `kordi.events.>` subject
//! tree. Other services (sync workers, presence services) will consume
//! these subjects to react to state changes without polling.
//!
//! The bus has a no-op fallback: when `NATS_URL` is unset, [`EventBus::noop`]
//! returns a value that silently drops every publish. This keeps local dev
//! and integration tests runnable without standing up NATS.

use std::time::Duration;

use async_nats::jetstream::{self, Context as JetStreamContext};
use bytes::Bytes;
use serde::Serialize;

#[derive(Debug)]
pub enum EventBusError {
    Connect(async_nats::ConnectError),
}

impl std::fmt::Display for EventBusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(err) => write!(f, "connect to NATS: {err}"),
        }
    }
}

impl std::error::Error for EventBusError {}

/// Publish handle for `kordi.events.>` subjects on the `KORDI_EVENTS` stream.
///
/// Cloning is cheap; the inner `Context` is reference-counted by `async-nats`.
#[derive(Clone)]
pub struct EventBus {
    inner: Option<JetStreamContext>,
}

impl EventBus {
    /// Connect to NATS at `url` and wrap a JetStream context. The
    /// `KORDI_EVENTS` stream is expected to already exist (created at
    /// cluster bootstrap); this function does NOT create it. That keeps
    /// the cloud-server image free of admin-level stream config and lets
    /// operators tune retention without redeploying.
    pub async fn connect(url: &str) -> Result<Self, EventBusError> {
        let client = async_nats::ConnectOptions::new()
            .request_timeout(Some(Duration::from_secs(5)))
            .connect(url)
            .await
            .map_err(EventBusError::Connect)?;
        let js = jetstream::new(client);
        Ok(Self { inner: Some(js) })
    }

    /// Drop-in fallback when NATS isn't configured. Every publish
    /// becomes a no-op. Keeps tests + local dev working.
    pub fn noop() -> Self {
        Self { inner: None }
    }

    /// Publish `payload` on `subject`. Errors are intentionally swallowed
    /// (logged to stderr) — the HTTP request that triggered this should
    /// not fail just because the bus is briefly unavailable. When we
    /// build the outbox in a later session, this becomes durable.
    async fn publish_raw(&self, subject: String, payload: Bytes) {
        let Some(js) = self.inner.as_ref() else {
            return;
        };
        match js.publish(subject.clone(), payload).await {
            Ok(ack_future) => {
                if let Err(err) = ack_future.await {
                    eprintln!("[events] publish ack {subject}: {err}");
                }
            }
            Err(err) => eprintln!("[events] publish {subject}: {err}"),
        }
    }

    /// Fire `kordi.events.account.signed_up.<account_id>` with a small
    /// JSON envelope. Subscribers can match on `kordi.events.account.>`
    /// or the more specific `kordi.events.account.signed_up.>`.
    pub async fn publish_signup(&self, account_id: &str, primary_email: &str) {
        if self.inner.is_none() {
            return;
        }
        let payload = AccountSignedUp {
            event_type: "account.signed_up",
            account_id,
            primary_email,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize signup: {err}");
                return;
            }
        };
        let subject = format!("kordi.events.account.signed_up.{account_id}");
        self.publish_raw(subject, body).await;
    }
}

#[derive(Serialize)]
struct AccountSignedUp<'a> {
    event_type: &'static str,
    account_id: &'a str,
    primary_email: &'a str,
    occurred_at: String,
}
