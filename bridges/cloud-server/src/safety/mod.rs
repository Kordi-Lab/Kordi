//! Trust and safety: account blocks and abuse reports.
//!
//! Blocks are private to the blocker and never notify the blocked account.
//! Reports are read only by named operators through logged SQL functions
//! (see `docs/trust-and-safety/abuse-reports.md`); the support inbox gets a
//! metadata-only notice for each new report. Report content never appears in
//! logs, audit events, or notices.

mod block_routes;
pub mod blocks;
mod notify;
pub mod reports;
pub mod retention;
mod routes;

pub use notify::spawn_report_notice_worker;
pub use retention::spawn_report_retention_worker;
pub use routes::routes;
