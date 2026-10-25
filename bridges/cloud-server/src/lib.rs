//! Kordi cloud-native collaboration server.
//!
//! Owns cloud accounts, sessions, devices, contacts, and the
//! canonical chat-sync store. Independent from the local-first
//! `bridges/cli` server: separate binary, separate database, separate
//! deployment surface. Local-edition users never run this code.

pub mod attachments;
pub mod auth;
pub mod avatars;
pub mod blob_emoji;
pub mod calls;
pub mod chat_sync;
pub mod client_ip;
pub mod cloud_agent_runtime;
pub mod cloud_agents;
pub mod common_ground;
pub mod connectors;
pub mod digest;
pub mod document_shares;
pub mod events;
pub(crate) mod memory_store;
pub mod notifications;
pub mod pg;
pub mod pip;
pub mod plan_cards;
pub mod presence;
pub mod proactive;
pub mod projects;
pub mod scheduled_tasks;
pub mod server;
pub mod support;
pub mod system_account;
pub mod updates;
pub mod ws;

pub use server::{router, run, ServerState};
