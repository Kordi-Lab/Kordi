//! Personal agents (docs/development/personal-agent.md). Every owned agent
//! has one personal session with its owner ([`sessions`]). With the agent's
//! Proactive setting on (`personalAgent.proactive`), it may write there
//! first about new connector events granted to it.
//!
//! The sweep follows the proactive one ([`crate::proactive`]): one state row
//! per agent with a `received_at` cursor, a cheap gate (new events, batching,
//! cooldown, daily caps), and one evaluation run whose only tool is
//! `search_memory`. Evaluations run on the owner's Mac first through the
//! proactive evaluation path ([`desktop`]), else on the cloud runner. A
//! `share` posts one agent message with its source events in the personal
//! session and pushes it; a `skip` only moves the cursor.

mod complete;
mod config;
pub(crate) mod desktop;
mod output;
mod prompt;
mod push;
pub mod routes;
pub(crate) mod sessions;
pub mod setting;
mod snapshot;
mod sources;
mod sweep;
mod worker;

pub use complete::{complete, fail, release_stale_runs};
pub use config::PersonalAgentConfig;
pub use setting::PersonalAgentSetting;
pub use sweep::sweep;
pub use worker::spawn;

/// Evaluation runs. Their completion never reaches chat delivery.
pub const RUN_PREFIX: &str = "personal_agent_eval_";

/// The hint that tells the owner's devices an evaluation waits for a Mac.
pub const EVAL_HINT: &str = "personal_agent.eval_requested";

/// The session id of an agent's evaluation runs. It names no conversation,
/// so evaluations never wait on, or hold up, the owner's chat runs.
pub fn run_session_id(agent_id: &str) -> String {
    format!("personal-agent:{agent_id}")
}

#[cfg(test)]
mod tests;
