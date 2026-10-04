//! The plan a person was shown when PiP suggested their answer or vote.
//!
//! An answer or vote suggestion names the plan as it stood: its title, time,
//! and place, or the option voted for. Approving it applies the answer only
//! while the card still says that, so no one confirms an answer to a plan they
//! were not shown. A revision that changes those details retires the
//! suggestion instead.

use serde_json::Value;

use super::models::{PlanCardRow, PlanCardState};
use super::revise::{same_instant, same_place};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShownPlan {
    /// An answer: the plan's title, time, and place.
    Answer {
        title: String,
        start_at: Option<String>,
        location: Option<String>,
    },
    /// A vote: the plan's title and the option's id and label.
    Vote {
        title: String,
        option_id: String,
        option_label: String,
    },
}

fn text(subject: &Value, key: &str) -> Option<String> {
    subject[key].as_str().map(str::to_string)
}

impl ShownPlan {
    /// What a `plan_rsvp` or `plan_vote` suggestion showed. Other kinds carry
    /// the revision they were made at instead.
    pub(crate) fn from_subject(kind: &str, subject: &Value) -> Option<Self> {
        let title = text(subject, "title").unwrap_or_default();
        match kind {
            "plan_rsvp" => Some(Self::Answer {
                title,
                start_at: text(subject, "startAt"),
                location: text(subject, "location"),
            }),
            "plan_vote" => Some(Self::Vote {
                title,
                option_id: text(subject, "optionId")?,
                option_label: text(subject, "optionLabel").unwrap_or_default(),
            }),
            _ => None,
        }
    }

    /// Whether the card still shows this plan.
    pub(crate) fn matches(&self, card: &PlanCardRow) -> bool {
        match self {
            Self::Answer {
                title,
                start_at,
                location,
            } => {
                title.trim() == card.title.trim()
                    && same_instant(start_at.as_deref(), card.start_at.as_deref())
                    && same_place(location.as_deref(), card.location.as_deref())
            }
            Self::Vote {
                title,
                option_id,
                option_label,
            } => {
                title.trim() == card.title.trim()
                    && card.state == PlanCardState::Polling
                    && card.options.iter().any(|option| {
                        &option.id == option_id && option.label.trim() == option_label.trim()
                    })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan_cards::models::PlanCardOption;
    use serde_json::json;

    fn card() -> PlanCardRow {
        PlanCardRow {
            event_id: "plan_1".to_string(),
            conversation_id: "c".to_string(),
            revision: 3,
            state: PlanCardState::Polling,
            title: "Dinner".to_string(),
            start_at: Some("2026-10-04T17:00:00+00:00".to_string()),
            end_at: None,
            location: Some("Cafe A".to_string()),
            unresolved_fields: Vec::new(),
            source_message_ids: Vec::new(),
            participants: Vec::new(),
            manager_ids: Vec::new(),
            options: vec![PlanCardOption {
                id: "opt_1".to_string(),
                label: "Friday 7pm".to_string(),
                start_at: None,
                end_at: None,
                location: None,
                votes: Vec::new(),
            }],
            note: None,
        }
    }

    #[test]
    fn an_answer_applies_only_to_the_time_and_place_it_showed() {
        let shown = ShownPlan::from_subject(
            "plan_rsvp",
            &json!({"eventId": "plan_1", "title": "Dinner", "rsvp": "yes",
                "startAt": "2026-10-04 17:00:00+00", "location": " cafe a "}),
        )
        .unwrap();
        let mut card = card();
        assert!(shown.matches(&card), "the same instant and place");
        card.revision = 9;
        assert!(shown.matches(&card), "other members' answers do not matter");
        card.start_at = Some("2026-10-11T17:00:00+00:00".to_string());
        assert!(!shown.matches(&card), "a new date");
        card.start_at = Some("2026-10-04T17:00:00+00:00".to_string());
        card.location = Some("Somewhere else".to_string());
        assert!(!shown.matches(&card), "a new place");
        card.location = Some("Cafe A".to_string());
        card.title = "Lunch".to_string();
        assert!(!shown.matches(&card), "a different plan");
        // A plan shown without a time stays without one.
        let untimed =
            ShownPlan::from_subject("plan_rsvp", &json!({"title": "Dinner", "rsvp": "no"}))
                .unwrap();
        let mut card = self::card();
        card.location = None;
        assert!(!untimed.matches(&card));
        card.start_at = None;
        assert!(untimed.matches(&card));
    }

    #[test]
    fn a_vote_applies_only_to_the_option_it_showed_while_polling() {
        let shown = ShownPlan::from_subject(
            "plan_vote",
            &json!({"eventId": "plan_1", "title": "Dinner", "optionId": "opt_1",
                "optionLabel": "Friday 7pm"}),
        )
        .unwrap();
        let mut card = card();
        assert!(shown.matches(&card));
        card.options[0].label = "Saturday noon".to_string();
        assert!(
            !shown.matches(&card),
            "the option now offers something else"
        );
        card.options[0].label = "Friday 7pm".to_string();
        card.state = PlanCardState::AwaitingConfirmation;
        assert!(!shown.matches(&card), "voting closed");
        assert!(ShownPlan::from_subject("plan_vote", &json!({"title": "Dinner"})).is_none());
        assert!(ShownPlan::from_subject("plan_confirm", &json!({"revision": 3})).is_none());
    }
}
