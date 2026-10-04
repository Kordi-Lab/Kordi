//! Trust and safety: abuse reports people send to Kordi.
//!
//! Reports are read only by named operators through logged SQL functions
//! (see `docs/trust-and-safety/abuse-reports.md`). Report content never
//! appears in logs or audit events.

pub mod reports;
pub mod retention;
mod routes;

pub use retention::spawn_report_retention_worker;
pub use routes::routes;
