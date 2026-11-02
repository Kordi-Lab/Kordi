//! Headless synthetic human participants. No desktop or browser dependencies.
pub mod cli;
pub mod client;
pub mod config;
pub mod decision;
pub mod deployment;
pub mod deployment_config;
pub mod protocol;
pub mod worker;

pub const HUMAN_REQUESTER_SKILL: &str =
    include_str!("../../../../simulations/skills/human-requester/SKILL.md");

/// Handle both interactive termination and container orchestrator shutdown.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
