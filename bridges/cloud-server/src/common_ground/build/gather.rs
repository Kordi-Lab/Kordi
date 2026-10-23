//! What a card build reads: the sources the owner turned on, redacted, in
//! the order the model sees them.

use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx_postgres::PgPool;

use crate::common_ground::profiles::SourcePicks;
use crate::common_ground::prompt::Gathered;
use crate::common_ground::redact::{redact, squeeze};

const MAX_DEVICE_GROUPS: usize = 4;
const MAX_DEVICE_ITEMS: usize = 300;
const MAX_LINKS: usize = 20;
const MAX_NOTES_CHARS: usize = 4000;
const MAX_TEXT_CHARS: usize = 600;
const MAX_TITLE_CHARS: usize = 140;
const MAX_MEMORIES: usize = 200;
const MAX_AGENT_FILES: usize = 12;
const MAX_AGENT_TEXT_CHARS: usize = 2000;
/// Total agent file text one request may carry, before redaction.
const MAX_AGENT_TOTAL_CHARS: usize = 60_000;
const AGENTS_SOURCE: &str = "Agents on this Mac";
/// Connector events from about the last six months.
const CONNECTOR_DAYS: i64 = 183;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::common_ground) struct BuildRequest {
    /// The profile to build; the default profile when omitted.
    pub profile_id: Option<String>,
    /// The account's own saved memories.
    memory: bool,
    /// Recent events from connected accounts.
    connectors: bool,
    /// The providers to read when `connectors` is on; every provider when
    /// omitted.
    connector_providers: Option<Vec<String>>,
    /// Titles and dates the app read on the device after the person allowed
    /// access (calendar events, reminders).
    device: Vec<DeviceGroup>,
    /// Links and text separated by `;` or new lines. Links are kept as given;
    /// the server does not fetch pages.
    links: String,
    notes: String,
    /// Agent instruction and memory files the app read on the Mac.
    agents: Vec<AgentFile>,
    /// Attachment ids of the account's own Kordi documents.
    pub documents: Vec<String>,
    /// The picks to remember on the profile, saved with the build.
    pub picks: Option<SourcePicks>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct AgentFile {
    label: String,
    text: String,
}

impl BuildRequest {
    pub fn agents_too_long(&self) -> bool {
        self.agents
            .iter()
            .map(|file| file.text.chars().count())
            .sum::<usize>()
            > MAX_AGENT_TOTAL_CHARS
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct DeviceGroup {
    source: String,
    items: Vec<DeviceItem>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct DeviceItem {
    title: String,
    date: Option<String>,
}

fn day(value: Option<&str>) -> Option<String> {
    let value = value?.get(..10)?;
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|d| d.to_string())
}

fn item(
    source: &str,
    title: &str,
    date: Option<String>,
    url: Option<String>,
    text: &str,
) -> Gathered {
    Gathered {
        source: squeeze(source, 40),
        title: squeeze(&redact(title), MAX_TITLE_CHARS),
        date,
        url,
        text: squeeze(&redact(text), MAX_TEXT_CHARS),
    }
}

pub(super) fn link_url(entry: &str) -> Option<String> {
    let lower = entry.to_ascii_lowercase();
    if (lower.starts_with("https://") || lower.starts_with("http://")) && !entry.contains(' ') {
        return Some(entry.to_string());
    }
    let host = entry.split('/').next()?;
    let looks_like_host = !entry.contains(' ')
        && host.contains('.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    looks_like_host.then(|| format!("https://{entry}"))
}

/// The text fields of a connector event summary, in order.
fn summary_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if !text.trim().is_empty() => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|v| summary_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| summary_strings(v, out)),
        _ => {}
    }
}

fn summary_title(summary: &Value) -> Option<String> {
    ["title", "subject", "summary", "name"]
        .iter()
        .find_map(|key| summary.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "gmail" => "Gmail",
        "google_calendar" => "Google Calendar",
        "github" => "GitHub",
        "slack" => "Slack",
        other => other,
    }
}

/// What the build reads, in the order the model sees it.
pub(in crate::common_ground) async fn gather(
    pool: &PgPool,
    account: &str,
    request: &BuildRequest,
) -> sqlx_core::Result<(Vec<Gathered>, Vec<String>)> {
    let mut evidence = Vec::new();
    let mut used = Vec::new();
    if request.memory {
        let list = crate::memory_store::list(pool, account)
            .await
            .map_err(|_| sqlx_core::Error::Protocol("Could not read memories.".into()))?;
        // Only memories the account saved itself: group memories can be
        // about other people.
        let own: Vec<_> = if list.settings.memory_enabled {
            list.memories
                .iter()
                .filter(|m| m.owner_account_id == account)
                .take(MAX_MEMORIES)
                .collect()
        } else {
            Vec::new()
        };
        for memory in &own {
            let title: String = memory.text.chars().take(80).collect();
            evidence.push(item(
                "Memory",
                &title,
                day(Some(&memory.updated_at)),
                None,
                &memory.text,
            ));
        }
        if !own.is_empty() {
            used.push("Memory".to_string());
        }
    }
    if request.connectors {
        let since = Utc::now() - Duration::days(CONNECTOR_DAYS);
        let providers = request.connector_providers.as_deref();
        let events =
            crate::connectors::digest_input::recent_events_from(pool, account, since, providers)
                .await?;
        let mut providers = Vec::new();
        for event in events {
            let mut strings = Vec::new();
            summary_strings(&event.summary, &mut strings);
            let title = summary_title(&event.summary).unwrap_or_else(|| event.kind.clone());
            let source = provider_label(&event.provider).to_string();
            evidence.push(item(
                &source,
                &title,
                day(Some(&event.occurred_at)),
                None,
                &strings.join(" · "),
            ));
            if !providers.contains(&source) {
                providers.push(source);
            }
        }
        used.extend(providers);
    }
    for group in request.device.iter().take(MAX_DEVICE_GROUPS) {
        let source = squeeze(&group.source, 40);
        let source = if source.is_empty() {
            "Device".to_string()
        } else {
            source
        };
        let mut count = 0;
        for entry in group.items.iter().take(MAX_DEVICE_ITEMS) {
            let title = squeeze(&entry.title, MAX_TITLE_CHARS);
            if !title.is_empty() {
                evidence.push(item(
                    &source,
                    &title,
                    day(entry.date.as_deref()),
                    None,
                    &title,
                ));
                count += 1;
            }
        }
        if count > 0 {
            used.push(source);
        }
    }
    let mut agent_files = 0;
    for file in request.agents.iter().take(MAX_AGENT_FILES) {
        let text = squeeze(&redact(&file.text), MAX_AGENT_TEXT_CHARS);
        if text.is_empty() {
            continue;
        }
        evidence.push(Gathered {
            source: AGENTS_SOURCE.into(),
            title: squeeze(&redact(&file.label), MAX_TITLE_CHARS),
            date: None,
            url: None,
            text,
        });
        agent_files += 1;
    }
    if agent_files > 0 {
        used.push("Agents".to_string());
    }
    let today = Utc::now().date_naive().to_string();
    let entries: Vec<&str> = request
        .links
        .split([';', '\n'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .take(MAX_LINKS)
        .collect();
    for entry in &entries {
        let url = link_url(entry);
        let source = if url.is_some() { "Link" } else { "Your words" };
        // The link itself is the reference; its text is what the model reads.
        let mut gathered = item(source, entry, Some(today.clone()), url.clone(), entry);
        if let Some(url) = url {
            gathered.title = squeeze(&url, MAX_TITLE_CHARS);
            gathered.text = squeeze(entry, MAX_TEXT_CHARS);
        }
        evidence.push(gathered);
    }
    if !entries.is_empty() {
        used.push("Links".to_string());
    }
    let notes: String = request.notes.trim().chars().take(MAX_NOTES_CHARS).collect();
    if !notes.is_empty() {
        evidence.push(Gathered {
            source: "Notes".into(),
            title: "Your notes".into(),
            date: Some(today),
            url: None,
            text: redact(&notes),
        });
        used.push("Notes".to_string());
    }
    Ok((evidence, used))
}

#[cfg(test)]
pub(in crate::common_ground) fn request_for_tests(notes: &str, links: &str) -> BuildRequest {
    BuildRequest {
        notes: notes.into(),
        links: links.into(),
        ..BuildRequest::default()
    }
}

#[cfg(test)]
pub(in crate::common_ground) fn link_url_for_tests(entry: &str) -> Option<String> {
    link_url(entry)
}
