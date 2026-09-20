//! What PiP is shown, and whether it needs to look at all.
//!
//! Every run is a paid model call, so two things happen before one is queued:
//! a free text check decides whether new messages could be about a plan, and
//! the snapshot the model sees is kept small no matter how long the chat or
//! how large the group is.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::plan_cards::models::{PlanCardRow, PlanCardRsvp};

/// Recent messages fetched for a run.
pub(crate) const CONTEXT_MESSAGE_FETCH: i64 = 30;
/// Characters kept from a single message.
pub(crate) const MESSAGE_CHAR_LIMIT: usize = 400;
/// Characters of message text across the whole snapshot.
pub(crate) const MESSAGE_CHAR_BUDGET: usize = 6_000;
/// Members listed by name; the rest are only counted.
pub(crate) const MEMBER_LIST_LIMIT: usize = 40;
/// Card participants listed by name in a large group.
pub(crate) const PARTICIPANT_LIST_LIMIT: usize = 30;

/// One chat message as fetched for a run.
pub(crate) struct ContextMessage {
    pub id: String,
    pub sequence: i64,
    pub sender_id: String,
    pub sender_name: String,
    pub kind: String,
    pub text: String,
    pub created_at: String,
}

/// Keeps the newest messages that fit the character budget, oldest first,
/// with each message cut to a readable length. Messages without text (card
/// messages) are left out; the open card is its own field.
pub(crate) fn budget_messages(
    mut newest_first: Vec<ContextMessage>,
    context_start_sequence: i64,
    seen_sequence: i64,
    pip_account_id: &str,
) -> Vec<Value> {
    newest_first.retain(|message| {
        message.sequence > context_start_sequence && !message.text.trim().is_empty()
    });
    let mut used = 0usize;
    let mut kept = Vec::new();
    for mut message in newest_first {
        if message.text.chars().count() > MESSAGE_CHAR_LIMIT {
            message.text = message
                .text
                .chars()
                .take(MESSAGE_CHAR_LIMIT)
                .collect::<String>()
                + "…";
        }
        let size = message.text.chars().count();
        if used + size > MESSAGE_CHAR_BUDGET && !kept.is_empty() {
            break;
        }
        used += size;
        kept.push(message);
    }
    kept.reverse();
    kept.into_iter()
        .map(|message| {
            json!({
                "messageId": message.id,
                "sequence": message.sequence,
                "isNew": message.sequence > seen_sequence,
                "senderId": message.sender_id,
                "senderName": message.sender_name,
                "fromPip": message.sender_id == pip_account_id,
                "kind": message.kind,
                "text": message.text,
                "createdAt": message.created_at,
            })
        })
        .collect()
}

/// The card as PiP needs it: every field that drives a decision, with vote
/// and participant lists reduced to counts plus the people PiP may need to
/// name once a group is large.
pub(crate) fn compact_card(row: &PlanCardRow) -> Value {
    let count = |rsvp: PlanCardRsvp| row.participants.iter().filter(|p| p.rsvp == rsvp).count();
    let total = row.participants.len();
    let small = total <= PARTICIPANT_LIST_LIMIT;
    let person = |participant: &crate::plan_cards::models::PlanCardParticipantStatus| {
        json!({
            "participantId": participant.account_id,
            "displayName": participant.display_name,
            "organizer": participant.organizer,
            "rsvp": participant.rsvp.as_db_str(),
        })
    };
    let participants: Vec<Value> = if small {
        row.participants.iter().map(person).collect()
    } else {
        // Organizers first, then people who have not answered (the ones worth
        // nudging), then a few who declined.
        let organizers = row.participants.iter().filter(|p| p.organizer);
        let pending = row
            .participants
            .iter()
            .filter(|p| !p.organizer && p.rsvp == PlanCardRsvp::Pending)
            .take(20);
        let declined = row
            .participants
            .iter()
            .filter(|p| !p.organizer && p.rsvp == PlanCardRsvp::No)
            .take(10);
        organizers
            .chain(pending)
            .chain(declined)
            .take(PARTICIPANT_LIST_LIMIT)
            .map(person)
            .collect()
    };
    let voters: BTreeSet<&str> = row
        .options
        .iter()
        .flat_map(|option| option.votes.iter().map(String::as_str))
        .collect();
    json!({
        "eventId": row.event_id,
        "revision": row.revision,
        "state": row.state.as_db_str(),
        "title": row.title,
        "startAt": row.start_at,
        "endAt": row.end_at,
        "location": row.location,
        "unresolvedFields": row.unresolved_fields,
        "options": row.options.iter().map(|option| {
            let mut value = json!({
                "id": option.id,
                "label": option.label,
                "startAt": option.start_at,
                "endAt": option.end_at,
                "location": option.location,
                "voteCount": option.votes.len(),
            });
            if small {
                value["voterIds"] = json!(option.votes);
            }
            value
        }).collect::<Vec<_>>(),
        "counts": {
            "participants": total,
            "going": count(PlanCardRsvp::Yes),
            "declined": count(PlanCardRsvp::No),
            "pending": count(PlanCardRsvp::Pending),
            "voted": voters.len(),
        },
        "participants": participants,
        "participantsTruncated": !small,
    })
}

/// Members listed for a run: everyone in a small group; in a large one the
/// people speaking in the snapshot and on the card come first, then others
/// up to the limit.
pub(crate) fn pick_members<'a, T>(
    members: &'a [T],
    account_id: impl Fn(&T) -> &str,
    featured: &BTreeSet<String>,
) -> Vec<&'a T> {
    if members.len() <= MEMBER_LIST_LIMIT {
        return members.iter().collect();
    }
    let (first, rest): (Vec<&T>, Vec<&T>) = members
        .iter()
        .partition(|member| featured.contains(account_id(member)));
    first
        .into_iter()
        .chain(rest)
        .take(MEMBER_LIST_LIMIT)
        .collect()
}

// Words that suggest someone is arranging something. English is matched on
// whole words; Chinese and Arabic are matched as substrings and written as
// escapes to keep the source ASCII.
const PLAN_WORDS: &[&str] = &[
    "today",
    "tonight",
    "tomorrow",
    "tmrw",
    "weekend",
    "weekday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "tue",
    "tues",
    "thu",
    "thur",
    "thurs",
    "fri",
    "morning",
    "afternoon",
    "evening",
    "noon",
    "midnight",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "schedule",
    "reschedule",
    "postpone",
    "cancel",
    "canceled",
    "cancelled",
    "plan",
    "plans",
    "meet",
    "meeting",
    "meetup",
    "hangout",
    "dinner",
    "lunch",
    "breakfast",
    "brunch",
    "coffee",
    "drinks",
    "party",
    "trip",
    "hike",
    "movie",
    "movies",
    "concert",
    "game",
    "games",
    "call",
    "zoom",
    "book",
    "booking",
    "reservation",
    "reserve",
    "event",
    "rsvp",
    "vote",
    "pip",
];
const ANSWER_WORDS: &[&str] = &[
    "yes",
    "yeah",
    "yep",
    "no",
    "nope",
    "ok",
    "okay",
    "sure",
    "in",
    "out",
    "cant",
    "cannot",
    "wont",
    "sorry",
    "works",
    "fine",
    "available",
    "free",
    "busy",
    "late",
    "come",
    "coming",
    "join",
    "skip",
    "maybe",
    "either",
    "both",
    "neither",
    "first",
    "second",
    "option",
];
const PLAN_SUBSTRINGS: &[&str] = &[
    // Chinese: today, tonight, tomorrow, day after tomorrow, weekend, next week,
    // this week, weekday, morning, noon, afternoon, evening, dinner party,
    // get-together, have a meal, meeting, movie, cancel, reschedule, postpone,
    // book, arrange, plan, free, not free, what time, where, can come, cannot come.
    "\u{4eca}\u{5929}",
    "\u{4eca}\u{665a}",
    "\u{660e}\u{5929}",
    "\u{540e}\u{5929}",
    "\u{5468}\u{672b}",
    "\u{4e0b}\u{5468}",
    "\u{8fd9}\u{5468}",
    "\u{661f}\u{671f}",
    "\u{65e9}\u{4e0a}",
    "\u{4e2d}\u{5348}",
    "\u{4e0b}\u{5348}",
    "\u{665a}\u{4e0a}",
    "\u{805a}\u{9910}",
    "\u{805a}\u{4f1a}",
    "\u{5403}\u{996d}",
    "\u{5f00}\u{4f1a}",
    "\u{7535}\u{5f71}",
    "\u{53d6}\u{6d88}",
    "\u{6539}\u{671f}",
    "\u{63a8}\u{8fdf}",
    "\u{9884}\u{7ea6}",
    "\u{5b89}\u{6392}",
    "\u{8ba1}\u{5212}",
    "\u{6709}\u{7a7a}",
    "\u{6ca1}\u{7a7a}",
    "\u{51e0}\u{70b9}",
    "\u{54ea}\u{91cc}",
    "\u{80fd}\u{6765}",
    "\u{6765}\u{4e0d}\u{4e86}",
    // Arabic: tomorrow (two forms), today, tonight, appointment, dinner, lunch,
    // coffee, meeting, the hour, Friday, Saturday, Thursday, we meet, cancel.
    "\u{063a}\u{062f}\u{0627}",
    "\u{0628}\u{0643}\u{0631}\u{0629}",
    "\u{0627}\u{0644}\u{064a}\u{0648}\u{0645}",
    "\u{0627}\u{0644}\u{0644}\u{064a}\u{0644}\u{0629}",
    "\u{0645}\u{0648}\u{0639}\u{062f}",
    "\u{0639}\u{0634}\u{0627}\u{0621}",
    "\u{063a}\u{062f}\u{0627}\u{0621}",
    "\u{0642}\u{0647}\u{0648}\u{0629}",
    "\u{0627}\u{062c}\u{062a}\u{0645}\u{0627}\u{0639}",
    "\u{0627}\u{0644}\u{0633}\u{0627}\u{0639}\u{0629}",
    "\u{0627}\u{0644}\u{062c}\u{0645}\u{0639}\u{0629}",
    "\u{0627}\u{0644}\u{0633}\u{0628}\u{062a}",
    "\u{0627}\u{0644}\u{062e}\u{0645}\u{064a}\u{0633}",
    "\u{0646}\u{0644}\u{062a}\u{0642}\u{064a}",
    "\u{0625}\u{0644}\u{063a}\u{0627}\u{0621}",
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace(['\u{2019}', '\''], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Clock times and short dates written with digits: 7pm, 7:30, 19:00, 9/20.
fn has_time_or_date(text: &str) -> bool {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < chars.len() && chars[index].is_ascii_digit() {
            index += 1;
        }
        if index - start > 2 {
            continue;
        }
        let rest: String = chars[index..chars.len().min(index + 4)].iter().collect();
        let rest = rest.trim_start();
        let followed_by_digits = |separator: char| {
            chars.get(index) == Some(&separator)
                && chars.get(index + 1).is_some_and(|c| c.is_ascii_digit())
        };
        // "7pm", "7 am", "19:30", "9/20", and "7\u{70b9}" (Chinese o'clock).
        if rest.starts_with("am")
            || rest.starts_with("pm")
            || rest.starts_with('\u{70b9}')
            || followed_by_digits(':')
            || followed_by_digits('/')
        {
            return true;
        }
    }
    false
}

/// Whether new messages could matter to a plan. Free and deliberately
/// generous: a miss costs a plan, a false alarm costs one model call.
/// While a card is open, short answers ("yes", "can't") also count.
pub(crate) fn worth_a_look(texts: &[String], has_open_card: bool) -> bool {
    texts.iter().any(|text| {
        if has_time_or_date(text) {
            return true;
        }
        let lower = text.to_lowercase();
        if PLAN_SUBSTRINGS.iter().any(|needle| lower.contains(needle)) {
            return true;
        }
        let words = words(text);
        if words.iter().any(|word| PLAN_WORDS.contains(&word.as_str())) {
            return true;
        }
        has_open_card
            && words
                .iter()
                .any(|word| ANSWER_WORDS.contains(&word.as_str()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn look(texts: &[&str], open: bool) -> bool {
        worth_a_look(
            &texts.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
            open,
        )
    }

    #[test]
    fn small_talk_is_skipped() {
        assert!(!look(&["haha that's great", "lol", "nice photo"], false));
        assert!(!look(&["ok sure"], false));
        assert!(!look(&["I am so tired"], false));
    }

    #[test]
    fn plans_times_and_dates_are_looked_at() {
        assert!(look(&["Dinner this Friday?"], false));
        assert!(look(&["see you at 7pm"], false));
        assert!(look(&["how about 19:30"], false));
        assert!(look(&["is 9/20 ok"], false));
        assert!(look(&["7\u{70b9}\u{89c1}"], false));
        assert!(look(&["\u{660e}\u{5929}\u{5403}\u{996d}\u{5417}"], false));
        assert!(look(
            &["\u{0645}\u{0648}\u{0639}\u{062f} \u{063a}\u{062f}\u{0627}"],
            false
        ));
    }

    #[test]
    fn short_answers_count_only_while_a_card_is_open() {
        assert!(!look(&["yes"], false));
        assert!(look(&["yes"], true));
        assert!(look(&["sorry I can't"], true));
    }

    #[test]
    fn long_numbers_are_not_times() {
        assert!(!look(&["order 12345 shipped"], false));
    }

    #[test]
    fn message_budget_excludes_pre_join_history_and_marks_only_unseen_messages() {
        let long = "x".repeat(MESSAGE_CHAR_LIMIT + 100);
        let messages: Vec<ContextMessage> = (0..30)
            .rev()
            .map(|sequence| ContextMessage {
                id: format!("m{sequence}"),
                sequence,
                sender_id: "acct_a".into(),
                sender_name: "A".into(),
                kind: "text".into(),
                text: long.clone(),
                created_at: String::new(),
            })
            .collect();
        let kept = budget_messages(messages, 10, 27, "acct_pip");
        assert!(kept.len() < 30);
        assert!(kept
            .iter()
            .all(|message| message["sequence"].as_i64().unwrap() > 10));
        assert_eq!(kept.last().unwrap()["sequence"], 29);
        assert_eq!(kept.last().unwrap()["isNew"], true);
        assert_eq!(
            kept.iter()
                .filter(|message| message["isNew"] == true)
                .count(),
            2
        );
        assert!(kept
            .iter()
            .all(|m| m["text"].as_str().unwrap().chars().count() <= MESSAGE_CHAR_LIMIT + 1));
    }
}
