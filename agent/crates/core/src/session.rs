//! Agent session types.
//!
//! The `AgentSession` struct implementation lives in the CLI crate
//! because it depends on `kordi-session`, `kordi-tools`, and `kordi-provider`,
//! which themselves depend on `kordi-core` (avoiding circular deps).
//!
//! This module re-exports the shared types used across the session boundary.
//!
//! Note: `AgentLoopEvent` and `ContextUsage` remain here only for transitional
//! legacy compatibility. New monitor/runtime code should prefer
//! `kordi_core::agent_session_runtime` and `kordi-monitor`.

#[doc(hidden)]
pub use crate::agent_loop::{AgentLoopEvent, ContextUsage};
