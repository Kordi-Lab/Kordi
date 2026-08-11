//! Reliable multi-device chat protocol.
//!
//! Version 2 is the exclusive product chat transport. Historical v1 tables
//! remain only as migration input; no v1 message or sync routes are mounted.
//! Canonical state fans out through a durable, contiguous per-user stream.

pub mod cursor;
pub mod models;
pub mod realtime;
pub mod retention;
pub mod routes;
pub mod store;

pub const PROTOCOL_VERSION: i32 = 2;
