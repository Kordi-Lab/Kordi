//! Reliable multi-device chat protocol.
//!
//! This is the canonical product chat transport. Canonical state fans out
//! through a durable, contiguous per-user stream.

pub mod cursor;
pub mod models;
pub mod realtime;
pub mod retention;
pub mod routes;
pub mod store;

pub const PROTOCOL_VERSION: i32 = 2;
