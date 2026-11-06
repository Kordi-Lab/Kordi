//! Kordi cloud-native collaboration server.
//!
//! Owns cloud accounts, sessions, devices, contacts, and the
//! canonical chat-sync store. Independent from the local-first
//! `bridges/cli` server: separate binary, separate database, separate
//! deployment surface. Local-edition users never run this code.

pub mod account_deletion;
pub mod ai_consent;
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
pub mod contact_permissions;
pub mod deleted_account;
pub mod digest;
pub mod distribution;
pub mod document_shares;
pub mod events;
pub mod human_simulator;
pub(crate) mod memory_store;
pub mod notifications;
pub mod organizations;
pub mod personal_agent;
pub mod pg;
pub mod plan_cards;
pub mod pool_workers;
pub mod presence;
pub mod proactive;
pub mod projects;
pub mod resource_pools;
pub mod safety;
pub mod scheduled_tasks;
pub mod server;
pub(crate) mod service_model;
mod service_model_config;
pub(crate) mod site_page;
pub mod support;
pub mod system_account;
pub mod system_agent;
pub mod updates;
pub mod web_pages;
pub mod ws;

pub use server::{router, run, ServerState};
