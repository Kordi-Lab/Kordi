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
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub claims: Vec<Item>,
    pub commitments: Vec<Item>,
    pub suggestions: Vec<Item>,
    pub calendar_candidates: Vec<Item>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub external_uid: Option<String>,
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
                        source.sender_account_id == id && item.source_ids.contains(&source.id)
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
    Ok(())
}

pub fn validate_event(event: &CalendarEvent) -> Result<(), &'static str> {
    if event.id.is_empty()
        || event.id.len() > 300
        || event.title.trim().is_empty()
        || event.title.len() > 500
        || event.description.len() > 5000
        || event.source_ids.len() > 20
        || event.external_uid.as_ref().is_some_and(|s| s.len() > 1000)
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
