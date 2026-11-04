//! An opt-in quality test for the System agent. It replays synthetic group
//! conversations and Grounding card builds through the real System agent path
//! (the server's sweep, prompt and plan_card handler, the runner's model loop)
//! against one configured provider, scores the results, and compares runs.
//!
//! Real runs call a model and are never part of CI; the stub provider keeps
//! the harness itself tested. See docs/testing/system-agent-quality.md.

pub mod client;
pub mod fixture;
pub mod grounding;
pub mod replay;
pub mod report;
pub mod score;
pub mod seed;
pub mod setup;
pub mod stub;

/// The fixtures shipped with the harness.
pub fn default_fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}
