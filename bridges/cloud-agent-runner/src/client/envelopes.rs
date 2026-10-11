//! Response envelopes of the cloud run routes. Each wraps the one value the
//! client hands back to its caller.
use serde::Deserialize;

use super::{ArtifactExportResponse, CloudAgentRun, ProviderAuthMaterial};

#[derive(Debug, Deserialize)]
pub(super) struct LeaseResponse {
    pub(super) run: Option<CloudAgentRun>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RunEnvelope {
    pub(super) run: CloudAgentRun,
}

#[derive(Debug, Deserialize)]
pub(super) struct HeartbeatEnvelope {
    pub(super) run: HeartbeatRun,
}

#[derive(Debug, Deserialize)]
pub(super) struct HeartbeatRun {
    #[serde(rename = "cancelRequested", default)]
    pub(super) cancel_requested: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProviderAuthEnvelope {
    #[serde(rename = "providerAuth")]
    pub(super) provider_auth: ProviderAuthMaterial,
}

#[derive(Debug, Deserialize)]
pub(super) struct ArtifactExportEnvelope {
    pub(super) artifact: ArtifactExportResponse,
}
