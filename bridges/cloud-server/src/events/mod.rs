//! Cloud-server event bus.
//!
//! Wraps a JetStream context so the server can publish lifecycle events
//! (signup, contacts, profiles, and presence) onto the `kordi.events.>` subject
//! tree. Other services (sync workers, presence services) will consume
//! these subjects to react to state changes without polling.
//!
//! The bus has a no-op fallback: when `NATS_URL` is unset, [`EventBus::noop`]
//! returns a value that silently drops every publish. This keeps local dev
//! and integration tests runnable without standing up NATS.

use std::time::Duration;

use async_nats::jetstream::{self, Context as JetStreamContext};
use async_nats::Client as NatsClient;
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
/// Cloning is cheap; both inner handles are reference-counted by `async-nats`.
#[derive(Clone)]
pub struct EventBus {
    inner: Option<EventBusInner>,
}

#[derive(Clone)]
struct EventBusInner {
    /// JetStream context for durable publishes.
    js: JetStreamContext,
    /// Plain NATS client for live subscriptions (the WS gateway uses
    /// this to receive real-time fanout — JetStream isn't required for
    /// the read side, plain core subscribes still see published msgs).
    client: NatsClient,
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
        let js = jetstream::new(client.clone());
        Ok(Self {
            inner: Some(EventBusInner { js, client }),
        })
    }

    /// Drop-in fallback when NATS isn't configured. Every publish
    /// becomes a no-op. Keeps tests + local dev working.
    pub fn noop() -> Self {
        Self { inner: None }
    }

    /// Return the underlying NATS client so callers (e.g. the WS
    /// gateway) can subscribe directly. `None` when the bus is in the
    /// no-op fallback. Cloning the [`NatsClient`] is cheap; subscribers
    /// typically clone once per connection.
    pub fn nats_client(&self) -> Option<NatsClient> {
        self.inner.as_ref().map(|inner| inner.client.clone())
    }

    /// Publish `payload` on `subject`. Errors are intentionally swallowed
    /// (logged to stderr) — the HTTP request that triggered this should
    /// not fail just because the bus is briefly unavailable. When we
    /// build the outbox in a later session, this becomes durable.
    async fn publish_raw(&self, subject: String, payload: Bytes) {
        let Some(inner) = self.inner.as_ref() else {
            return;
        };
        match inner.js.publish(subject.clone(), payload).await {
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

    /// Fire `kordi.events.contact.added.<peer_account_id>`. The receiver
    /// of the notification is the peer (the one being added) — that's
    /// the account whose open WebSocket should see the event light up,
    /// matching the verification scenario in the architecture spec.
    pub async fn publish_contact_added(&self, actor_account_id: &str, peer_account_id: &str) {
        if self.inner.is_none() {
            return;
        }
        let payload = ContactAdded {
            event_type: "contact.added",
            actor_account_id,
            peer_account_id,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize contact.added: {err}");
                return;
            }
        };
        let subject = format!("kordi.events.contact.added.{peer_account_id}");
        self.publish_raw(subject, body).await;
    }

    /// Fire `kordi.events.contact.request.<event>.<recipient_account_id>`.
    /// For `created`, the recipient is the one being asked. For
    /// `accepted`/`rejected`, the recipient is the original requester
    /// (so their UI can flip "pending" → "accepted"/"rejected").
    pub async fn publish_contact_request_event(
        &self,
        event_kind: ContactRequestEventKind,
        request_id: &str,
        from_account_id: &str,
        to_account_id: &str,
    ) {
        if self.inner.is_none() {
            return;
        }
        let recipient = match event_kind {
            ContactRequestEventKind::Created => to_account_id,
            ContactRequestEventKind::Accepted | ContactRequestEventKind::Rejected => {
                from_account_id
            }
        };
        let payload = ContactRequestEvent {
            event_type: match event_kind {
                ContactRequestEventKind::Created => "contact.request.created",
                ContactRequestEventKind::Accepted => "contact.request.accepted",
                ContactRequestEventKind::Rejected => "contact.request.rejected",
            },
            request_id,
            from_account_id,
            to_account_id,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize contact.request: {err}");
                return;
            }
        };
        let subject = format!(
            "kordi.events.contact.{}.{recipient}",
            match event_kind {
                ContactRequestEventKind::Created => "request.created",
                ContactRequestEventKind::Accepted => "request.accepted",
                ContactRequestEventKind::Rejected => "request.rejected",
            }
        );
        self.publish_raw(subject, body).await;
    }

    /// Fire `kordi.events.account.profile.updated.<observer_account_id>` so
    /// contacts with an open Cloud websocket can refresh display name/avatar.
    pub async fn publish_profile_updated(
        &self,
        account_id: &str,
        observer_account_id: &str,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) {
        if self.inner.is_none() {
            return;
        }
        let payload = AccountProfileUpdated {
            event_type: "account.profile.updated",
            account_id,
            observer_account_id,
            display_name,
            avatar_url,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize account.profile.updated: {err}");
                return;
            }
        };
        let subject = format!("kordi.events.account.profile.updated.{observer_account_id}");
        self.publish_raw(subject, body).await;
    }

    pub async fn publish_presence_account_changed(
        &self,
        account_id: &str,
        observer_account_id: &str,
        status: &str,
    ) {
        if self.inner.is_none() {
            return;
        }
        let payload = PresenceAccountChanged {
            event_type: "presence.account.changed",
            account_id,
            status,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        };
        let body = match serde_json::to_vec(&payload) {
            Ok(value) => Bytes::from(value),
            Err(err) => {
                eprintln!("[events] serialize presence.account.changed: {err}");
                return;
            }
        };
        let subject = format!("kordi.events.presence.account.{observer_account_id}");
        self.publish_raw(subject, body).await;
    }

    /// Publish a device lifecycle hint. The canonical event is already in the
    /// account sync stream; this subject only wakes older live subscribers.
    pub async fn publish_device_event(&self, account_id: &str, event_kind: &str, device_id: &str) {
        if self.inner.is_none() {
            return;
        }
        let payload = serde_json::json!({
            "event_type": format!("device.{event_kind}"),
            "account_id": account_id,
            "device_id": device_id,
            "occurred_at": chrono::Utc::now().to_rfc3339(),
        });
        let Ok(body) = serde_json::to_vec(&payload) else {
            return;
        };
        self.publish_raw(
            format!("kordi.events.device.{event_kind}.{account_id}"),
            Bytes::from(body),
        )
        .await;
    }

    /// Tell every live gateway holding a socket for this device to close it.
    /// Durable authorization remains PostgreSQL-backed; this is the prompt
    /// cross-replica invalidation path.
    pub async fn publish_device_revoked(&self, device_id: &str) {
        let Some(inner) = self.inner.as_ref() else {
            return;
        };
        if let Err(error) = inner
            .client
            .publish(
                format!("kordi.device.control.{device_id}"),
                Bytes::from_static(b"revoked"),
            )
            .await
        {
            eprintln!("[events] publish device revocation: {error}");
        }
    }
}

#[derive(Clone, Copy)]
pub enum ContactRequestEventKind {
    Created,
    Accepted,
    Rejected,
}

#[derive(Serialize)]
struct AccountSignedUp<'a> {
    event_type: &'static str,
    account_id: &'a str,
    primary_email: &'a str,
    occurred_at: String,
}

#[derive(Serialize)]
struct ContactAdded<'a> {
    event_type: &'static str,
    actor_account_id: &'a str,
    peer_account_id: &'a str,
    occurred_at: String,
}

#[derive(Serialize)]
struct ContactRequestEvent<'a> {
    event_type: &'static str,
    request_id: &'a str,
    from_account_id: &'a str,
    to_account_id: &'a str,
    occurred_at: String,
}

#[derive(Serialize)]
struct AccountProfileUpdated<'a> {
    event_type: &'static str,
    account_id: &'a str,
    observer_account_id: &'a str,
    display_name: Option<&'a str>,
    avatar_url: Option<&'a str>,
    occurred_at: String,
}

#[derive(Serialize)]
struct PresenceAccountChanged<'a> {
    event_type: &'static str,
    account_id: &'a str,
    status: &'a str,
    occurred_at: String,
}
