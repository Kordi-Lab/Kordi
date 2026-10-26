//! Proactive agents: an owned agent that watches its owner's groups and asks
//! the owner before it helps (docs/development/proactive-agent.md).
//!
//! The sweep copies the System agent's shape: one cursor row per agent and
//! group, a free text check, one evaluation run per candidate whose only tool
//! is `search_memory` ([`memory_search`]). An `offer` becomes a proposal that
//! only the owner sees, inside the group, from the proposals route, a
//! `proactive.proposal_changed` hint, and a push; no message is posted. Nothing
//! reaches the group until the owner allows it, and the approved run is an
//! ordinary owner-started group run with the usual delivery. The owner's
//! default agent watches the same way under its synthetic id (agents.rs).

pub(crate) mod agents;
mod complete;
mod config;
pub(crate) mod decision;
pub(crate) mod desktop;
pub(crate) mod memory_search;
mod output;
mod prefilter;
mod prompt;
pub(crate) mod proposal;
mod push;
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
/// Whether `run_id` is a proactive run, which needs no project folder in a
/// group that is a project session: an evaluation's only tool reads
/// memories, and an approved run works in an empty folder of its own.
pub fn needs_no_project_folder(run_id: &str) -> bool {
    run_id.starts_with(RUN_PREFIX) || run_id.starts_with(APPROVED_RUN_PREFIX)
}

/// The readiness row a Mac publishes when it can run proactive runs
/// ([`desktop`]). Without it the cloud runner answers at once.
pub const CAPABILITY: &str = "proactive";

#[cfg(test)]
mod tests;
