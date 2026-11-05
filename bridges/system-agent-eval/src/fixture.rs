//! Fixture files: synthetic group conversations and Grounding card builds,
//! each with the outcome a good System agent produces.
//!
//! Dates in fixture text are templates resolved against the moment a fixture
//! is replayed, because the System agent reads the real clock:
//! `{{d+3}}` is a UTC date (`2026-11-06`), `{{d+3:weekday}}` its weekday,
//! `{{d+3:long}}` "Friday, November 6", and `{{now+20h}}` or `{{now+90m}}` an
//! RFC 3339 instant.

use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Timelike, Utc};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Fixture {
    SystemAgent(Conversation),
    Grounding(CardBuildFixture),
}

impl Fixture {
    pub fn id(&self) -> &str {
        match self {
            Self::SystemAgent(conversation) => &conversation.id,
            Self::Grounding(build) => &build.id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::SystemAgent(_) => "systemAgent",
            Self::Grounding(_) => "grounding",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conversation {
    pub id: String,
    pub description: String,
    pub title: String,
    pub members: Vec<Member>,
    #[serde(default)]
    pub history: Vec<Message>,
    #[serde(default)]
    pub card: Option<SeedCard>,
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    /// Short key fixtures use to refer to the member, such as `maya`.
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub timezone: Option<String>,
}

/// One chat message. `from` is a member key or `system` for the System agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub from: String,
    pub text: String,
    /// How long before the replay the message was sent.
    pub minutes_ago: i64,
    /// Member keys mentioned as people, `system` for the System agent, or
    /// `agent:<key>` for that member's personal agent.
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// A card that already exists when the conversation starts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedCard {
    pub organizer: String,
    pub title: String,
    /// `polling`, `awaitingConfirmation` or `confirmed`.
    pub state: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub options: Vec<SeedOption>,
    /// `[member, optionIndex]` pairs.
    #[serde(default)]
    pub votes: Vec<(String, usize)>,
    /// `[member, "yes" | "no"]` pairs.
    #[serde(default)]
    pub rsvps: Vec<(String, String)>,
    /// One-shot reminders already sent, such as `t_minus_24h`.
    #[serde(default)]
    pub reminders_sent: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedOption {
    pub label: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

/// One sweep: new messages and card responses, then one System agent pass.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Turn {
    #[serde(default)]
    pub messages: Vec<Message>,
    /// Members acting on the card itself before the pass.
    #[serde(default)]
    pub card_actions: Vec<CardAction>,
    pub expect: Expect,
    /// The scripted replies the stub provider gives for this pass.
    #[serde(default)]
    pub stub: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum CardAction {
    Vote { by: String, option: usize },
    Rsvp { by: String, rsvp: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expect {
    /// `silent`, `message`, or `any`.
    pub reply: String,
    /// Groups of alternatives; the message must match one word of each group.
    #[serde(default)]
    pub message_includes: Vec<Vec<String>>,
    /// plan_card actions this pass may use. Anything else is an invalid call.
    #[serde(default)]
    pub allowed_actions: Vec<String>,
    /// plan_card actions this pass must use successfully.
    #[serde(default)]
    pub required_actions: Vec<String>,
    #[serde(default)]
    pub card: Option<ExpectCard>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectCard {
    /// `none`: no card may exist. `unchanged`: the card's revision must not
    /// move. Omitted: the card must exist and match the fields below.
    #[serde(default)]
    pub status: Option<String>,
    /// Accepted states, in database spelling (`awaiting_confirmation`).
    #[serde(default)]
    pub state: Vec<String>,
    #[serde(default)]
    pub title_includes: Vec<String>,
    /// Exact instant; `null` requires the time to be unset.
    #[serde(default, deserialize_with = "present")]
    pub start_at: Option<Option<String>>,
    #[serde(default)]
    pub location_includes: Vec<String>,
    #[serde(default)]
    pub option_count: Option<usize>,
    /// Whether the card must be the one seeded in the fixture.
    #[serde(default)]
    pub same_card: bool,
    #[serde(default)]
    pub going: Vec<String>,
    #[serde(default)]
    pub declined: Vec<String>,
}

/// Distinguishes an explicit `null` from a missing field.
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardBuildFixture {
    pub id: String,
    pub description: String,
    pub profile: CardProfile,
    pub evidence: Vec<CardEvidence>,
    pub expect: ExpectTopics,
    /// The stub provider's reply.
    #[serde(default)]
    pub stub: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardProfile {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub focus: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardEvidence {
    pub source: String,
    pub title: String,
    pub days_ago: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectTopics {
    pub min_current_topics: usize,
    /// Groups of alternatives; some topic label must match one word of each.
    #[serde(default)]
    pub must_mention: Vec<Vec<String>>,
    /// Words no topic label may contain.
    #[serde(default)]
    pub must_not_mention: Vec<String>,
}

/// Replaces date templates in `text` relative to `now`.
pub fn expand(text: &str, now: DateTime<Utc>) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .with_context(|| format!("unclosed template in {text:?}"))?;
        out.push_str(&expand_one(after[..end].trim(), now)?);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn expand_one(token: &str, now: DateTime<Utc>) -> Result<String> {
    if let Some(offset) = token.strip_prefix("now+") {
        let (amount, unit) = offset.split_at(offset.len().saturating_sub(1));
        let amount: i64 = amount.parse().with_context(|| format!("bad {token}"))?;
        let delta = match unit {
            "m" => Duration::minutes(amount),
            "h" => Duration::hours(amount),
            _ => bail!("unknown unit in {token}"),
        };
        let at = (now + delta)
            .with_second(0)
            .and_then(|at| at.with_nanosecond(0));
        return Ok(at.context("valid instant")?.to_rfc3339());
    }
    let Some(spec) = token.strip_prefix("d+") else {
        bail!("unknown template {{{{{token}}}}}");
    };
    let (days, format) = spec.split_once(':').unwrap_or((spec, "date"));
    let days: i64 = days.parse().with_context(|| format!("bad {token}"))?;
    let day = (now + Duration::days(days)).date_naive();
    Ok(match format {
        "date" => day.format("%Y-%m-%d").to_string(),
        "weekday" => day.format("%A").to_string(),
        "long" => day.format("%A, %B %-d").to_string(),
        _ => bail!("unknown date format in {token}"),
    })
}

/// Loads every `*.json` fixture under `dir`, sorted by file name, with its
/// templates resolved against `now`.
pub fn load_dir(dir: &Path, now: DateTime<Utc>) -> Result<Vec<Fixture>> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    paths.sort();
    let mut fixtures = Vec::new();
    for path in paths {
        if path.is_dir() {
            fixtures.extend(load_dir(&path, now)?);
        } else if path.extension().is_some_and(|ext| ext == "json") {
            fixtures.push(load_file(&path, now)?);
        }
    }
    let mut ids = std::collections::BTreeSet::new();
    for fixture in &fixtures {
        if !ids.insert(fixture.id().to_string()) {
            bail!("duplicate fixture id {}", fixture.id());
        }
    }
    Ok(fixtures)
}

pub fn load_file(path: &Path, now: DateTime<Utc>) -> Result<Fixture> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&raw, now).with_context(|| format!("in {}", path.display()))
}

pub fn parse(raw: &str, now: DateTime<Utc>) -> Result<Fixture> {
    let fixture: Fixture = serde_json::from_str(&expand(raw, now)?)?;
    validate(&fixture)?;
    Ok(fixture)
}

const ACTIONS: [&str; 5] = ["propose", "rsvp", "vote", "confirm", "cancel"];

fn validate(fixture: &Fixture) -> Result<()> {
    let Fixture::SystemAgent(conversation) = fixture else {
        return Ok(());
    };
    let known = |key: &str| conversation.members.iter().any(|member| member.key == key);
    let speaker = |key: &str| key == "system" || known(key);
    // History, then the seeded card, then each turn's messages.
    let card_age = crate::seed::SEEDED_CARD_MINUTES_AGO;
    for message in &conversation.history {
        if message.minutes_ago <= card_age {
            bail!("history messages must be more than {card_age} minutes old");
        }
    }
    for message in conversation.turns.iter().flat_map(|turn| &turn.messages) {
        if !(1..card_age).contains(&message.minutes_ago) {
            bail!("turn messages must be 1 to {} minutes old", card_age - 1);
        }
    }
    for message in conversation
        .history
        .iter()
        .chain(conversation.turns.iter().flat_map(|turn| &turn.messages))
    {
        if !speaker(&message.from) {
            bail!("unknown sender {}", message.from);
        }
    }
    if let Some(card) = &conversation.card {
        if !known(&card.organizer) {
            bail!("unknown organizer {}", card.organizer);
        }
    }
    if conversation.turns.is_empty() {
        bail!("a conversation needs at least one turn");
    }
    for turn in &conversation.turns {
        let expect = &turn.expect;
        if !["silent", "message", "any"].contains(&expect.reply.as_str()) {
            bail!("reply must be silent, message, or any");
        }
        for action in expect
            .allowed_actions
            .iter()
            .chain(&expect.required_actions)
        {
            if !ACTIONS.contains(&action.as_str()) {
                bail!("unknown plan_card action {action}");
            }
        }
        if let Some(card) = &expect.card {
            for key in card.going.iter().chain(&card.declined) {
                if !known(key) {
                    bail!("unknown member {key} in expected card");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-11-03T10:15:42Z".parse().unwrap()
    }

    #[test]
    fn templates_resolve_against_the_replay_clock() {
        let text = "{{d+3:weekday}} {{d+3:long}} at {{d+3}}T19:00:00+00:00, reminder {{now+90m}}";
        assert_eq!(
            expand(text, now()).unwrap(),
            "Friday Friday, November 6 at 2026-11-06T19:00:00+00:00, reminder 2026-11-03T11:45:00+00:00"
        );
        assert!(expand("{{d+x}}", now()).is_err());
        assert!(expand("{{d+1", now()).is_err());
    }

    #[test]
    fn every_fixture_in_the_repository_loads() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let fixtures = load_dir(&dir, now()).unwrap();
        let count = |kind| fixtures.iter().filter(|f| f.kind() == kind).count();
        assert!(count("systemAgent") >= 10);
        assert!(count("grounding") >= 2);
        // Every pass has a stub script, so the stub run covers every fixture.
        for fixture in &fixtures {
            match fixture {
                Fixture::SystemAgent(conversation) => {
                    for turn in &conversation.turns {
                        assert!(!turn.stub.is_empty(), "{} lacks a stub", conversation.id);
                    }
                }
                Fixture::Grounding(build) => {
                    assert!(build.stub.is_some(), "{} lacks a stub", build.id)
                }
            }
        }
    }

    #[test]
    fn unknown_members_and_actions_are_rejected() {
        let base = r#"{"kind":"systemAgent","id":"x","description":"d","title":"t",
            "members":[{"key":"a","name":"A"}],
            "turns":[{"messages":[{"from":"MSG","text":"hi","minutesAgo":2}],
            "expect":{"reply":"silent","allowedActions":["ACTION"]}}]}"#;
        assert!(parse(&base.replace("MSG", "a").replace("ACTION", "rsvp"), now()).is_ok());
        assert!(parse(&base.replace("MSG", "zed").replace("ACTION", "rsvp"), now()).is_err());
        assert!(parse(&base.replace("MSG", "a").replace("ACTION", "reopen"), now()).is_err());
    }
}
