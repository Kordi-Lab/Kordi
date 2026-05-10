//! Kordi cloud-native collaboration server.
//!
//! Owns cloud accounts, sessions, devices, contacts, and the
//! Telegram-style message log. Independent from the local-first
//! `bridges/cli` server: separate binary, separate database, separate
//! deployment surface. Local-edition users never run this code.

pub mod auth;
pub mod events;
pub mod messages;
pub mod pg;
pub mod server;

pub use server::{router, run, ServerState};
