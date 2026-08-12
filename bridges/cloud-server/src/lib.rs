//! Kordi cloud-native collaboration server.
//!
//! Owns cloud accounts, sessions, devices, contacts, and the
//! canonical chat-sync store. Independent from the local-first
//! `bridges/cli` server: separate binary, separate database, separate
//! deployment surface. Local-edition users never run this code.

pub mod attachments;
pub mod auth;
pub mod chat_sync;
pub mod cloud_agent_runtime;
pub mod cloud_agents;
pub mod events;
pub mod pg;
pub mod presence;
pub mod scheduled_tasks;
pub mod server;
pub mod support;
pub mod updates;
pub mod ws;

pub use server::{router, run, ServerState};
