//! Listener module — dispatches inbound peer messages to local agent runtimes.
//!
//! Replaces the TypeScript listener. Everything runs inside the daemon process.

pub mod dispatch;
pub mod runtimes;
