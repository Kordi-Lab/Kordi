use super::models::{CalendarEvent, Input, Item, Output, Source};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub sources: Vec<Source>,
    #[serde(default)]
    pub related_sources: Vec<Source>,
    pub removed_source_ids: Vec<String>,
    pub calendar_events: Vec<CalendarEvent>,
    pub removed_calendar_event_ids: Vec<String>,
    pub existing_tasks: Vec<Value>,
    pub removed_task_ids: Vec<String>,
    pub newly_due_reminder_ids: Vec<String>,
    pub preferences_changed: bool,
}

fn diff<T: Clone + PartialEq>(
    before: &[T],
    after: &[T],
    key: fn(&T) -> String,
    unchanged: fn(&T, &T) -> bool,
) -> (Vec<T>, Vec<String>) {
    let saved: HashMap<_, _> = before.iter().map(|row| (key(row), row)).collect();
    let current: HashSet<_> = after.iter().map(key).collect();
    let changed = after
        .iter()
        .filter(|row| {
            saved
                .get(&key(row))
                .is_none_or(|before| !unchanged(before, row))
        })
        .cloned()
        .collect();
    let removed = saved
        .keys()
        .filter(|id| !current.contains(*id))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    (changed, removed)
}

pub(super) fn due_reminders(input: &Input) -> BTreeSet<String> {
    let Ok(as_of) = DateTime::parse_from_rfc3339(&input.as_of) else {
        return BTreeSet::new();
    };
    input
        .calendar_events
        .iter()
        .filter(|event| {
            event
                .reminder_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|time| time <= as_of)
        })
        .map(|event| event.id.clone())
        .collect()
}

impl Changes {
    pub fn between(saved: &Input, current: &Input) -> Self {
        // ponytail: diff existing bounded snapshots; use a durable event cursor if source limits grow.
        let (sources, removed_source_ids) = diff(
            &saved.sources,
            &current.sources,
            |source| source.id.clone(),
            |before, after| {
                if before == after {
                    return true;
                }
                // Account avatars are presentation metadata, not new evidence for the model.
                let mut before = before.clone();
                before.sender_avatar_url = after.sender_avatar_url.clone();
                before == *after
            },
        );
        let (calendar_events, removed_calendar_event_ids) = diff(
            &saved.calendar_events,
            &current.calendar_events,
            |event| event.id.clone(),
            PartialEq::eq,
        );
        let (existing_tasks, removed_task_ids) = diff(
            saved
                .existing_tasks
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            current
                .existing_tasks
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            |task| {
                task.get(0)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            },
            PartialEq::eq,
        );
        let related_ids: HashSet<_> = sources
            .iter()
            .filter_map(|source| source.reply_to_source_id.as_ref())
            .collect();
        let related_sources = current
            .sources
            .iter()
            .filter(|source| {
                related_ids.contains(&source.id)
                    && !sources.iter().any(|changed| changed.id == source.id)
            })
            .cloned()
            .collect();
        Self {
            sources,
            related_sources,
            removed_source_ids,
            calendar_events,
            removed_calendar_event_ids,
            existing_tasks,
            removed_task_ids,
            newly_due_reminder_ids: due_reminders(current)
                .difference(&due_reminders(saved))
                .cloned()
                .collect(),
            preferences_changed: current.locale != saved.locale
                || current.timezone != saved.timezone
                || current.partial != saved.partial,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
            && self.removed_source_ids.is_empty()
            && self.calendar_events.is_empty()
            && self.removed_calendar_event_ids.is_empty()
            && self.existing_tasks.is_empty()
            && self.removed_task_ids.is_empty()
            && self.newly_due_reminder_ids.is_empty()
            && !self.preferences_changed
    }
}

fn items(output: &Output) -> impl Iterator<Item = &Item> {
    output
        .claims
        .iter()
        .chain(&output.commitments)
        .chain(&output.suggestions)
        .chain(&output.calendar_candidates)
}

pub fn merge_output(input: &Input, patch: Output) -> Result<Output, &'static str> {
    if input.changes.is_none() {
        return if patch.removed_item_ids.is_empty() {
            Ok(patch)
        } else {
            Err("Full reports cannot remove prior items")
        };
    }
    let mut next = input
        .previous
        .clone()
        .ok_or("Incremental input requires a baseline")?;
    let previous_ids: HashSet<_> = items(&next).map(|item| item.id.clone()).collect();
    let updated_ids: HashSet<_> = items(&patch).map(|item| item.id.clone()).collect();
    let removed: HashSet<_> = patch.removed_item_ids.iter().cloned().collect();
    if updated_ids.len() != items(&patch).count()
        || removed.len() != patch.removed_item_ids.len()
        || !removed.is_subset(&previous_ids)
        || !removed.is_disjoint(&updated_ids)
    {
        return Err("Invalid incremental item identities");
    }
    next.calendar_candidates.retain(|item| {
        if let Some(series) = &item.existing_series_id {
            return input
                .calendar_events
                .iter()
                .any(|event| event.series_id.as_ref() == Some(series));
        }
        item.existing_event_id.as_ref().is_none_or(|id| {
            input.calendar_events.iter().any(|event| {
                &event.id == id && Some(event.revision) == item.existing_event_revision
            })
        })
    });
    for (current, updated) in [
        (&mut next.claims, patch.claims),
        (&mut next.commitments, patch.commitments),
        (&mut next.suggestions, patch.suggestions),
        (&mut next.calendar_candidates, patch.calendar_candidates),
    ] {
        current.retain(|item| !updated_ids.contains(&item.id) && !removed.contains(&item.id));
        current.extend(updated);
    }
    next.removed_item_ids.clear();
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Input {
        serde_json::from_value(json!({"sources":[
            {"id":"old","conversationId":"c","sessionId":"s","sessionTitle":"Planning","senderAccountId":"viewer","senderName":"Viewer","text":"Existing evidence","createdAt":"2026-09-07T00:00:00Z","version":1},
            {"id":"edited","conversationId":"c","sessionId":"s","sessionTitle":"Planning","senderAccountId":"viewer","senderName":"Viewer","text":"Old text","createdAt":"2026-09-07T00:00:00Z","version":1}],
            "calendarEvents":[],"existingTasks":[["task","Review","open",null,null]],
            "previous":{"claims":[{"id":"retained","title":"Existing summary","text":"","sourceIds":["old"],"kind":"progress"}],"commitments":[],"suggestions":[],"calendarCandidates":[]},
            "locale":"en","timezone":"UTC","partial":false,"asOf":"2026-09-07T00:00:00Z","viewerAccountId":"viewer"})).unwrap()
    }

    #[test]
    fn unchanged_sources_are_not_repeated_and_edits_removals_are_explicit() {
        let saved = snapshot();
        assert!(Changes::between(&saved, &saved).is_empty());
        let mut current = saved.clone();
        current.sources[1].version += 1;
        current.sources[1].text = "Updated time".into();
        current.sources[1].reply_to_source_id = Some("old".into());
        let changes = Changes::between(&saved, &current);
        assert_eq!(changes.sources.len(), 1);
        assert_eq!(changes.sources[0].id, "edited");
        assert!(changes.removed_source_ids.is_empty());
        assert_eq!(changes.related_sources.len(), 1);
        assert_eq!(changes.related_sources[0].id, "old");
        current.sources.remove(0);
        current.existing_tasks = json!([]);
        let changes = Changes::between(&saved, &current);
        assert_eq!(changes.removed_source_ids, ["old"]);
        assert_eq!(changes.removed_task_ids, ["task"]);
    }

    #[test]
    fn incremental_results_preserve_unaffected_items_and_allow_explicit_removal() {
        let mut input = snapshot();
        input.changes = Some(Changes::default());
        let added = Item {
            id: "new".into(),
            title: "New suggestion".into(),
            source_ids: vec!["edited".into()],
            kind: "possible".into(),
            ..Default::default()
        };
        let merged = merge_output(
            &input,
            Output {
                suggestions: vec![added.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(merged.claims[0].id, "retained");
        assert_eq!(merged.suggestions[0].id, "new");
        let removed = merge_output(
            &input,
            Output {
                removed_item_ids: vec!["retained".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(removed.claims.is_empty());
        assert!(removed.removed_item_ids.is_empty());
        assert!(merge_output(
            &input,
            Output {
                removed_item_ids: vec!["unknown".into()],
                ..Default::default()
            }
        )
        .is_err());
        assert!(merge_output(
            &input,
            Output {
                claims: vec![added.clone()],
                suggestions: vec![added],
                ..Default::default()
            }
        )
        .is_err());
        input.changes = None;
        assert!(merge_output(
            &input,
            Output {
                removed_item_ids: vec!["retained".into()],
                ..Default::default()
            }
        )
        .is_err());
    }
}
