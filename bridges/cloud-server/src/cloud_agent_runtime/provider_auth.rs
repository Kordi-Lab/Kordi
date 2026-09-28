//! Provider-auth snapshots: encrypted saved accounts, their lifecycle, and
//! exact route resolution for runs.

mod cipher;
mod codex_refresh;
mod provider_family;
mod publish_request;
mod readiness;
mod resolve;
mod service;
mod snapshots;

pub use cipher::{EnvProviderAuthCipher, ProviderAuthCipher, ProviderAuthCipherError};
pub(crate) use provider_family::equivalent_provider_ids;
pub use publish_request::{
    NormalizedProviderAuthSnapshotInput, PublishProviderAuthSnapshotRequest, MAX_PAYLOAD_BYTES,
};
pub use resolve::{
    provider_auth_for_account_route, provider_auth_for_run, ProviderAuthForRunResult,
};
pub use service::{
    RunnerProviderAuthMaterial, RunnerProviderAuthMaterialEnvelope, ServiceProviderAuth,
};
pub(crate) use snapshots::snapshot_available_for_route;
pub use snapshots::{
    current_snapshot, list_snapshots, publish_snapshot, record_snapshot_used, revoke_snapshot,
    snapshot_capacity_available, CurrentProviderAuthSnapshotQuery,
    CurrentProviderAuthSnapshotResponse, ProviderAuthSnapshotResponse,
    ProviderAuthSnapshotsResponse, PublishSnapshotError, MAX_LIVE_SNAPSHOTS_PER_ACCOUNT,
};

#[cfg(test)]
mod tests {
    use super::provider_family::equivalent_provider_ids;

    #[test]
    fn provider_aliases_share_one_authentication_family() {
        let openai = vec![
            "openai".to_string(),
            "openai-codex".to_string(),
            "codex".to_string(),
        ];
        assert_eq!(
            equivalent_provider_ids(Some("OpenAI")),
            Some(openai.clone())
        );
        assert_eq!(equivalent_provider_ids(Some("openai-codex")), Some(openai));
        assert_eq!(
            equivalent_provider_ids(Some("google-gemini")),
            Some(vec!["google".to_string(), "google-gemini".to_string()])
        );
        assert_eq!(
            equivalent_provider_ids(Some("anthropic")),
            Some(vec!["anthropic".to_string()])
        );
        assert_eq!(equivalent_provider_ids(Some("  ")), None);
    }
}
