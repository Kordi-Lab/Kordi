//! What a card keeps when it is revised. A revision never throws away what
//! members already said: a vote stays on an option that still offers the same
//! time and place, and an answer stays while the plan's own time and place are
//! unchanged. Someone taken off the card loses theirs.

use chrono::{DateTime, FixedOffset};

use super::models::{PlanCardOption, PlanCardProposeArgs, PlanCardRow, PlanCardRsvp};
use super::store::parse_pg_timestamp;

fn same_instant(left: Option<&str>, right: Option<&str>) -> bool {
    let instant = |value: &str| -> Option<DateTime<FixedOffset>> { parse_pg_timestamp(value) };
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => match (instant(left), instant(right)) {
            (Some(left), Some(right)) => left == right,
            _ => left.trim() == right.trim(),
        },
        _ => false,
    }
}

fn same_place(left: Option<&str>, right: Option<&str>) -> bool {
    let place = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase)
    };
    place(left) == place(right)
}

/// Whether a revised option still offers what people voted for. An option
/// with neither a time nor a place is only its label.
fn same_choice(previous: &PlanCardOption, next: &PlanCardOption) -> bool {
    same_instant(previous.start_at.as_deref(), next.start_at.as_deref())
        && same_instant(previous.end_at.as_deref(), next.end_at.as_deref())
        && same_place(previous.location.as_deref(), next.location.as_deref())
        && (previous.start_at.is_some()
            || previous.location.is_some()
            || previous
                .label
                .trim()
                .eq_ignore_ascii_case(next.label.trim()))
}

/// Moves each vote from the previous options onto the revised option that
/// offers the same choice, preferring one with the same id. Votes from people
/// no longer on the card are dropped.
pub(super) fn carry_votes(
    previous: &[PlanCardOption],
    mut next: Vec<PlanCardOption>,
    participant_ids: &[String],
) -> Vec<PlanCardOption> {
    let mut taken = vec![false; previous.len()];
    for option in &mut next {
        let candidates = || {
            previous
                .iter()
                .enumerate()
                .filter(|(index, old)| !taken[*index] && same_choice(old, option))
        };
        let matched = candidates()
            .find(|(_, old)| old.id == option.id)
            .or_else(|| candidates().next())
            .map(|(index, _)| index);
        if let Some(index) = matched {
            taken[index] = true;
            option.votes = previous[index]
                .votes
                .iter()
                .filter(|voter| participant_ids.contains(voter))
                .cloned()
                .collect();
        }
    }
    next
}

/// Whether members' answers still apply: the plan's own time and place did
/// not change.
pub(super) fn keeps_answers(previous: &PlanCardRow, args: &PlanCardProposeArgs) -> bool {
    same_instant(previous.start_at.as_deref(), args.start_at.as_deref())
        && same_instant(previous.end_at.as_deref(), args.end_at.as_deref())
        && same_place(previous.location.as_deref(), args.location.as_deref())
}

/// A participant's answer on the revised card: the one they gave if it still
/// applies, otherwise pending, and yes for the organizer who proposed it.
pub(super) fn revised_rsvp(
    previous: Option<&PlanCardRow>,
    account_id: &str,
    organizer: bool,
) -> PlanCardRsvp {
    let kept = previous
        .and_then(|row| {
            row.participants
                .iter()
                .find(|participant| participant.account_id == account_id)
        })
        .map(|participant| participant.rsvp)
        .filter(|rsvp| *rsvp != PlanCardRsvp::Pending);
    match kept {
        Some(rsvp) => rsvp,
        None if organizer => PlanCardRsvp::Yes,
        None => PlanCardRsvp::Pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, label: &str, start_at: Option<&str>, votes: &[&str]) -> PlanCardOption {
        PlanCardOption {
            id: id.to_string(),
            label: label.to_string(),
            start_at: start_at.map(str::to_string),
            end_at: None,
            location: None,
            votes: votes.iter().map(|voter| voter.to_string()).collect(),
        }
    }

    #[test]
    fn votes_follow_the_same_time_even_when_options_are_reordered() {
        let previous = vec![
            option(
                "opt_1",
                "Fri 7pm",
                Some("2026-09-25T19:00:00+00:00"),
                &["a", "b"],
            ),
            option("opt_2", "Sat noon", Some("2026-09-26T12:00:00Z"), &["c"]),
        ];
        let next = vec![
            option("opt_1", "Sun brunch", Some("2026-09-27T11:00:00Z"), &[]),
            option("opt_2", "Friday 7pm", Some("2026-09-25T19:00:00Z"), &[]),
            option(
                "opt_3",
                "Saturday lunch",
                Some("2026-09-26 12:00:00+00"),
                &[],
            ),
        ];
        let participants = ["a".to_string(), "c".to_string()];
        let carried = carry_votes(&previous, next, &participants);
        assert!(carried[0].votes.is_empty());
        assert_eq!(carried[1].votes, vec!["a".to_string()]);
        assert_eq!(carried[2].votes, vec!["c".to_string()]);
    }

    #[test]
    fn untimed_options_match_by_label_and_changed_times_lose_votes() {
        let previous = vec![
            option("opt_1", "Pizza", None, &["a"]),
            option("opt_2", "Fri 7pm", Some("2026-09-25T19:00:00Z"), &["b"]),
        ];
        let next = vec![
            option("opt_1", "pizza ", None, &[]),
            option("opt_2", "Fri 8pm", Some("2026-09-25T20:00:00Z"), &[]),
        ];
        let participants = ["a".to_string(), "b".to_string()];
        let carried = carry_votes(&previous, next, &participants);
        assert_eq!(carried[0].votes, vec!["a".to_string()]);
        assert!(carried[1].votes.is_empty());
    }
}
