//! Card builds without a database, for the System agent quality test: the
//! same redaction, instructions and reply parsing a real build uses, fed with
//! synthetic evidence instead of an account's sources.

use std::collections::BTreeMap;

use super::profiles::Profile;
use super::prompt::{self, Gathered};

/// One synthetic evidence item, before redaction.
#[derive(Debug, Clone)]
pub struct EvidenceItem {
    pub source: String,
    pub title: String,
    pub date: Option<String>,
    pub text: String,
}

/// The topics a parsed reply produced, with the evidence ids (`e1`, `e2`, ...)
/// each topic cites.
#[derive(Debug, Clone, Default)]
pub struct CardTopics {
    pub working_on: Vec<String>,
    pub interests: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
    pub earlier: Vec<String>,
    pub refs: BTreeMap<String, Vec<String>>,
}

/// One card build's instructions, as a real build would queue them.
pub struct CardBuild {
    pub system_prompt: String,
    pub user_prompt: String,
    gathered: Vec<Gathered>,
}

impl CardBuild {
    /// `kind` is work, health, daily or custom; `today` is `YYYY-MM-DD`.
    pub fn new(
        kind: &str,
        name: &str,
        focus: Option<&str>,
        today: &str,
        evidence: &[EvidenceItem],
    ) -> Self {
        let profile = Profile {
            profile_id: "cgp_quality".into(),
            account_id: "acct_quality".into(),
            kind: kind.into(),
            name: name.into(),
            focus: focus.map(str::to_string),
            position: 0,
            design: None,
            icon: None,
            sources: None,
        };
        let gathered: Vec<Gathered> = evidence
            .iter()
            .map(|item| {
                super::build::item(
                    &item.source,
                    &item.title,
                    item.date.clone(),
                    None,
                    &item.text,
                )
            })
            .collect();
        Self {
            system_prompt: prompt::system_prompt(&profile),
            user_prompt: prompt::user_prompt(today, &profile, &gathered),
            gathered,
        }
    }

    /// Parses a reply the way a finished build does. The error is the code
    /// clients would show (`invalid_output` or `no_topics`).
    pub fn parse(&self, reply: &str) -> Result<CardTopics, &'static str> {
        let (topics, _) =
            prompt::parse_reply(reply, &self.gathered).map_err(|error| error.code())?;
        Ok(CardTopics {
            working_on: topics.working_on,
            interests: topics.interests,
            can_help: topics.can_help,
            looking_for: topics.looking_for,
            earlier: topics.earlier,
            refs: topics.refs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_synthetic_build_redacts_evidence_and_parses_cited_topics() {
        let build = CardBuild::new(
            "work",
            "Work",
            None,
            "2026-11-01",
            &[EvidenceItem {
                source: "note".into(),
                title: "Sensor dashboard".into(),
                date: Some("2026-10-20".into()),
                text: "Write to ada@example.test about the sensor dashboard".into(),
            }],
        );
        assert!(build.system_prompt.contains("work profile"));
        assert!(build.user_prompt.contains("[0] 2026-10-20"));
        assert!(!build.user_prompt.contains("ada@example.test"));
        let topics = build
            .parse(r#"{"working_on":[{"label":"Sensor dashboard","evidence":[0, 7]}]}"#)
            .unwrap();
        assert_eq!(topics.working_on, vec!["Sensor dashboard"]);
        assert_eq!(topics.refs["Sensor dashboard"], vec!["e1"]);
        assert_eq!(build.parse("not json").unwrap_err(), "invalid_output");
        assert_eq!(
            build.parse(r#"{"working_on":[]}"#).unwrap_err(),
            "no_topics"
        );
    }
}
