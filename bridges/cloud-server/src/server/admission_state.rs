//! Who may use the instance and join its configured organizations: the
//! instance admission policy and the organization admission file.

use std::sync::Arc;

use super::ServerState;
use crate::auth::admission::AdmissionPolicy;
use crate::organizations::admission::OrganizationAdmission;

impl ServerState {
    pub fn admission(&self) -> &AdmissionPolicy {
        &self.admission
    }

    pub fn with_admission(mut self, policy: AdmissionPolicy) -> Self {
        self.admission = policy;
        self
    }

    pub fn organization_admission(&self) -> &OrganizationAdmission {
        &self.organization_admission
    }

    /// Takes an admission file already synced to the database.
    pub fn with_organization_admission(mut self, synced: OrganizationAdmission) -> Self {
        self.organization_admission = Arc::new(synced);
        self
    }
}
