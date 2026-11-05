//! Who may use the instance and join its configured organizations: the
//! instance admission policy and the organization admission file.

use super::ServerState;
use crate::auth::admission::AdmissionPolicy;
use crate::organizations::admission::LiveAdmission;

impl ServerState {
    pub fn admission(&self) -> &AdmissionPolicy {
        &self.admission
    }

    pub fn with_admission(mut self, policy: AdmissionPolicy) -> Self {
        self.admission = policy;
        self
    }

    /// The running admission file; take [`LiveAdmission::current`] for one
    /// decision.
    pub fn organization_admission(&self) -> &LiveAdmission {
        &self.organization_admission
    }

    /// Takes an admission file already synced to the database.
    pub fn with_organization_admission(mut self, synced: impl Into<LiveAdmission>) -> Self {
        self.organization_admission = synced.into();
        self
    }
}
