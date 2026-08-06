mod completion;
mod decision;
mod diagnostics;
mod eligibility;
mod enqueue;
mod envelope;

pub(crate) use completion::finish_without_message;
pub(crate) use decision::{parse_model_decision, ModelDecision};
pub use diagnostics::{list_run_diagnostics, RunDiagnostic};
pub(crate) use eligibility::{cancel_if_ineligible, evidence_is_canonical, run_still_eligible};
pub use enqueue::spawn_enqueue_for_message;

pub const SKILL_PACK_ID: &str = "proact-v1";
pub(super) const SKILL_PACK_MANIFEST: &str =
    include_str!("../../../../../shared/proactive/proact-v1.json");
