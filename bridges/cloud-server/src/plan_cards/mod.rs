//! Shared, stateful plan cards for group-chat coordination (issue #1546).
//!
//! One card per proposed plan, conversation-scoped, driven by five
//! revision-checked operations: propose, rsvp, confirm, reopen, cancel.
//! RSVP is tracked separately from the card's top-level state so a single
//! non-organizer decline is structurally incapable of canceling the plan —
//! `rsvp` never writes to the `state` column.
//!
//! This module owns persistence only. Authorization (an actor must be an
//! active member of the card's conversation) is enforced in `store`, so it
//! holds regardless of what calls it later — an HTTP route today, a
//! digest-style background sweep in a future slice.

pub mod models;
mod routes;
mod runner;
pub use runner::runner_action;
pub mod calendar;
pub mod store;

pub use routes::routes;

#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod tests;
