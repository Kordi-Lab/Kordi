//! Kordi cloud-native collaboration server.
//!
//! Owns cloud accounts, sessions, devices, contacts, and the
//! Telegram-style message log. Independent from the local-first
//! `bridges/cli` server: separate binary, separate SQLite database,
//! separate deployment surface. Local-edition users never run this code.

pub mod auth;
pub mod db_runner;
pub mod error;
pub mod messages;
pub mod pg;
pub mod schema;
pub mod server;

pub use server::{router, run, ServerState};
