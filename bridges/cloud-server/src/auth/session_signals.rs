//! Session revocation signals for long-lived sockets.
//!
//! Migration 0175 publishes a `cloud_session_signals` notification whenever a
//! session or device is revoked or deleted, or the account facts behind
//! instance admission change. The per-replica realtime listener parses each
//! payload and routes it here, and every open socket of the affected account
//! receives it at once. Sockets therefore only need an occasional backstop
//! recheck instead of polling PostgreSQL every few seconds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tokio::sync::broadcast;

/// The PostgreSQL notification channel the signals arrive on.
pub(crate) const SESSION_SIGNAL_CHANNEL: &str = "cloud_session_signals";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SignalKind {
    /// The session, device, or account is gone: matching sockets close.
    Revoked,
    /// Something admission depends on changed: matching sockets recheck.
    Recheck,
}

/// One signal. A `None` device or token matches every device or session of
/// the account.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct SessionSignal {
    #[serde(rename = "a")]
    pub(crate) account_id: String,
    #[serde(rename = "d")]
    pub(crate) device_id: Option<String>,
    #[serde(rename = "t")]
    pub(crate) token_id: Option<String>,
    #[serde(rename = "k")]
    pub(crate) kind: SignalKind,
}

impl SessionSignal {
    pub(crate) fn parse(payload: &str) -> Option<Self> {
        serde_json::from_str::<Self>(payload)
            .ok()
            .filter(|signal| !signal.account_id.is_empty())
    }

    fn applies_to(&self, device_id: &str, token_id: Option<&str>) -> bool {
        self.device_id.as_deref().is_none_or(|id| id == device_id)
            && match (self.token_id.as_deref(), token_id) {
                (None, _) => true,
                (Some(signalled), Some(own)) => signalled == own,
                // A socket without a session (legacy ticket) is bound to its
                // device only; one session ending does not end it.
                (Some(_), None) => false,
            }
    }
}

/// What a socket must do about a signal it received.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SignalVerdict {
    Close,
    Recheck,
}

/// Routes signals to the sockets of one account, like the chat wake hub.
pub(crate) struct SessionSignalHub {
    accounts: Mutex<HashMap<String, broadcast::Sender<SessionSignal>>>,
}

impl SessionSignalHub {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
        })
    }

    /// Subscribe the socket of `account_id` on `device_id`, opened with the
    /// session `token_id` (`None` for a legacy device-only ticket).
    pub(crate) fn subscribe(
        self: &Arc<Self>,
        account_id: &str,
        device_id: &str,
        token_id: Option<&str>,
    ) -> SessionSignalSubscription {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sender = accounts
            .entry(account_id.to_string())
            .or_insert_with(|| broadcast::channel(16).0);
        SessionSignalSubscription {
            account_id: account_id.to_string(),
            device_id: device_id.to_string(),
            token_id: token_id.map(ToString::to_string),
            receiver: sender.subscribe(),
            hub: self.clone(),
        }
    }

    pub(crate) fn publish(&self, signal: SessionSignal) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let account_id = signal.account_id.clone();
        if accounts
            .get(&account_id)
            .is_some_and(|sender| sender.send(signal).is_err())
        {
            accounts.remove(&account_id);
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

pub(crate) struct SessionSignalSubscription {
    account_id: String,
    device_id: String,
    token_id: Option<String>,
    receiver: broadcast::Receiver<SessionSignal>,
    hub: Arc<SessionSignalHub>,
}

impl SessionSignalSubscription {
    /// Waits for the next signal that concerns this socket. Missed signals
    /// (a lagging receiver) ask for a recheck, so none is ever ignored.
    pub(crate) async fn recv(&mut self) -> SignalVerdict {
        loop {
            match self.receiver.recv().await {
                Ok(signal) if signal.applies_to(&self.device_id, self.token_id.as_deref()) => {
                    return match signal.kind {
                        SignalKind::Revoked => SignalVerdict::Close,
                        SignalKind::Recheck => SignalVerdict::Recheck,
                    };
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => return SignalVerdict::Recheck,
                Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
            }
        }
    }
}

impl Drop for SessionSignalSubscription {
    fn drop(&mut self) {
        self.hub.release(&self.account_id);
    }
}

#[cfg(test)]
mod tests;
