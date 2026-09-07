use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub session_title: String,
    pub sender_account_id: String,
    pub sender_name: String,
    pub text: String,
    pub created_at: String,
    pub version: i32,
    #[serde(default)]
    pub is_agent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_owner_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_avatar_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub kind: String,
    pub owner_account_id: Option<String>,
    pub due_at: Option<String>,
    pub existing_task_id: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_event_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<super::recurrence::Recurrence>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub claims: Vec<Item>,
    pub commitments: Vec<Item>,
    pub suggestions: Vec<Item>,
    pub calendar_candidates: Vec<Item>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_item_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub sources: Vec<Source>,
    pub calendar_events: Vec<CalendarEvent>,
    pub existing_tasks: serde_json::Value,
    pub previous: Option<Output>,
    pub locale: String,
    pub timezone: String,
    pub partial: bool,
    pub as_of: String,
    pub viewer_account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<super::incremental::Changes>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub external_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<super::recurrence::Recurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_single_occurrence: Option<bool>,
    #[serde(default)]
    pub revision: i64,
}

pub fn validate_output(output: &Output, input: &Input) -> Result<(), &'static str> {
    use std::collections::HashSet;
    let ids: HashSet<_> = input.sources.iter().map(|s| s.id.as_str()).collect();
    let mut items = HashSet::new();
    for item in output
        .claims
        .iter()
        .chain(&output.commitments)
        .chain(&output.suggestions)
        .chain(&output.calendar_candidates)
    {
        if !item
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
            || item.id.is_empty()
            || item.id.len() > 160
            || !items.insert(&item.id)
            || item.title.trim().is_empty()
            || item.title.len() > 500
            || item.text.len() > 4000
            || ![
                "decision", "progress", "blocker", "question", "open", "done", "possible",
            ]
            .contains(&item.kind.as_str())
            || item.source_ids.is_empty()
            || item.source_ids.len() > 20
            || !item.source_ids.iter().all(|id| ids.contains(id.as_str()))
            || item.owner_account_id.as_deref().is_some_and(|id| {
                id != input.viewer_account_id
                    && !input.sources.iter().any(|source| {
                        !source.is_agent
                            && source.sender_account_id == id
                            && item.source_ids.contains(&source.id)
                    })
            })
        {
            return Err("The generated digest contained an invalid item or source.");
        }
        for value in [&item.due_at, &item.start_at, &item.end_at]
            .into_iter()
            .flatten()
        {
            if chrono::DateTime::parse_from_rfc3339(value).is_err() {
                return Err("Invalid generated date.");
            }
        }
    }
    if items.len() > 100 {
        return Err("Too many generated items.");
    }
    for item in &output.calendar_candidates {
        if let Some(rule) = &item.recurrence {
            super::recurrence::validate(rule, false)?;
        }
        match item.calendar_action.as_deref().unwrap_or("create") {
            "create"
                if item.existing_event_id.is_none() && item.existing_event_revision.is_none() => {}
            "update" | "delete"
                if input.calendar_events.iter().any(|event| {
                    Some(&event.id) == item.existing_event_id.as_ref()
                        && Some(event.revision) == item.existing_event_revision
                }) => {}
            _ => {
                return Err("A calendar suggestion must reference the exact saved event revision.")
            }
        }
    }
    Ok(())
}

pub fn validate_event(event: &CalendarEvent) -> Result<(), &'static str> {
    if let Some(rule) = &event.recurrence {
        super::recurrence::validate(rule, true)?;
    }
    if event.revision < 0
        || event.id.is_empty()
        || event.id.len() > 300
        || event.title.trim().is_empty()
        || event.title.len() > 500
        || event.description.len() > 5000
        || event.source_ids.len() > 20
        || event.external_uid.as_ref().is_some_and(|s| s.len() > 1000)
        || event
            .timezone
            .as_ref()
            .is_some_and(|zone| zone.is_empty() || zone.len() > 100)
        || event
            .series_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 260)
        || event
            .series_fingerprint
            .as_ref()
            .is_some_and(|value| value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()))
        || event.links.as_ref().is_some_and(|links| {
            links.len() > 10
                || links.iter().any(|link| {
                    link.len() > 2048
                        || url::Url::parse(link).map_or(true, |url| {
                            !matches!(url.scheme(), "http" | "https")
                                || url.host_str().is_none()
                                || !url.username().is_empty()
                                || url.password().is_some()
                        })
                })
        })
    {
        return Err("Invalid calendar event.");
    }
    let start =
        chrono::DateTime::parse_from_rfc3339(&event.start_at).map_err(|_| "Invalid start time.")?;
    if let Some(end) = &event.end_at {
        if chrono::DateTime::parse_from_rfc3339(end).map_err(|_| "Invalid end time.")? <= start {
            return Err("End must follow start.");
        }
    }
    if let Some(reminder) = &event.reminder_at {
        let reminder =
            chrono::DateTime::parse_from_rfc3339(reminder).map_err(|_| "Invalid reminder time.")?;
        if reminder > start || start.signed_duration_since(reminder) > chrono::Duration::days(7) {
            return Err("Reminder must be within seven days before the event.");
        }
    }
    Ok(())
}

pub fn normalize_event_times(event: &mut CalendarEvent) -> Result<(), &'static str> {
    fn instant(value: &str, all_day: bool) -> Result<String, &'static str> {
        let date =
            chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "Invalid event date.")?;
        Ok(if all_day {
            format!("{}T00:00:00Z", date.date_naive())
        } else {
            date.with_timezone(&chrono::Utc).to_rfc3339()
        })
    }
    event.start_at = instant(&event.start_at, event.all_day)?;
    event.end_at = event
        .end_at
        .as_deref()
        .map(|date| instant(date, event.all_day))
        .transpose()?;
    event.reminder_at = event
        .reminder_at
        .as_deref()
        .map(|date| instant(date, false))
        .transpose()?;
    Ok(())
}
