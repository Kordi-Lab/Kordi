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

/// SQL condition for a card still in play, on a table aliased `card`: not
/// canceled, and not over (two hours past its end, or its start when it has
/// no end). A card with no time yet stays in play for 30 days after its last
/// change. PiP's sweep, PiP's run input, and the digest's guard all use it, so
/// they agree on which card is open.
macro_rules! live_plan_card_sql {
    () => {
        "(card.state <> 'canceled' AND (
             COALESCE(card.end_at, card.start_at) > now() - interval '2 hours'
             OR (card.start_at IS NULL AND card.updated_at > now() - interval '30 days')))"
    };
}
pub(crate) use live_plan_card_sql;

pub mod calendar;
pub mod models;
mod revise;
mod routes;
mod runner;
pub mod store;
mod transitions;
mod wire;

pub use runner::runner_action;

pub use routes::routes;

#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod revise_tests;
#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod vote_tests;
