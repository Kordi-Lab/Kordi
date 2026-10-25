//! Proactive agents: an owned agent that watches its owner's groups and asks
//! the owner before it helps (docs/development/proactive-agent.md).
//!
//! The sweep copies PiP's shape: one cursor row per agent and group, a free
//! text check, one tool-less evaluation run per candidate. An `offer` becomes
//! a proposal and a card in the owner's conversation with the agent; nothing
//! reaches the group until the owner allows it, and the approved run is an
//! ordinary owner-started group run with the usual delivery.

pub(crate) mod card;
mod complete;
mod config;
pub(crate) mod decision;
mod output;
mod prefilter;
mod prompt;
pub mod routes;
pub mod setting;
mod snapshot;
mod sweep;
mod worker;

pub use complete::{complete, fail, release_stale_runs};
pub use config::ProactiveConfig;
pub use decision::{reply_agent, sync_runs};
pub use setting::ProactiveSetting;
pub use sweep::sweep;
pub use worker::spawn;

/// Evaluation runs. Their completion never reaches group delivery.
pub const RUN_PREFIX: &str = "proactive_eval_";
/// Runs the owner allowed: ordinary group runs, delivered as the agent.
pub const APPROVED_RUN_PREFIX: &str = "proactive_run_";
/// The readiness row a Mac publishes when it can run evaluations. No Mac
/// publishes it yet, so the cloud runner answers every evaluation.
pub const CAPABILITY: &str = "proactive";

#[cfg(test)]
mod tests;
