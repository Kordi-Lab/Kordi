//! Common ground preview: lets the card builder ask for Calendar or Reminders
//! access on this Mac and read titles with their dates only (no attendees,
//! places, or notes). Dates let the card show when each topic came up.
//! Nothing is read until the person asks; titles go to the page that asked,
//! which sends them once to build the card.
//!
//! It also reads the person's agent instruction and memory files from their
//! home directory, when the build screen asks, so the card can draw on them.
//! Their contents are returned to the page only and never logged.
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{blocking, MacLocalPermission};

const MAX_TITLES: usize = 300;
const MONTHS_BACK: i64 = 6;
const MONTHS_AHEAD: i64 = 2;
const MAX_AGENT_FILES: usize = 12;
const MAX_AGENT_FILE_CHARS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CommonGroundDeviceStatus {
    pub calendar: MacLocalPermission,
    pub reminders: MacLocalPermission,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommonGroundDeviceItem {
    pub title: String,
    /// `YYYY-MM-DD`: event start, reminder due date, or none.
    pub date: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Calendar,
    Reminders,
}

impl Source {
    fn parse(source: &str) -> Result<Self, String> {
        match source {
            "calendar" => Ok(Self::Calendar),
            "reminders" => Ok(Self::Reminders),
            _ => Err(format!("Unknown source: {source}")),
        }
    }
}

#[cfg(target_os = "macos")]
fn current_status() -> CommonGroundDeviceStatus {
    use objc2_event_kit::EKEntityType;
    CommonGroundDeviceStatus {
        calendar: super::eventkit::permission(EKEntityType::Event),
        reminders: super::eventkit::permission(EKEntityType::Reminder),
    }
}

#[cfg(not(target_os = "macos"))]
fn current_status() -> CommonGroundDeviceStatus {
    CommonGroundDeviceStatus {
        calendar: MacLocalPermission::Unavailable,
        reminders: MacLocalPermission::Unavailable,
    }
}

#[tauri::command]
pub async fn common_ground_device_status() -> Result<CommonGroundDeviceStatus, String> {
    blocking(current_status).await
}

/// Shows the macOS prompt while the source is undecided, then reports status.
#[tauri::command]
pub async fn common_ground_device_request(
    source: String,
) -> Result<CommonGroundDeviceStatus, String> {
    let source = Source::parse(&source)?;
    #[cfg(target_os = "macos")]
    {
        blocking(move || {
            use objc2_event_kit::EKEntityType;
            let entity = match source {
                Source::Calendar => EKEntityType::Event,
                Source::Reminders => EKEntityType::Reminder,
            };
            let store = super::eventkit::store();
            super::eventkit::request_full_access(&store, entity).map(|_| ())
        })
        .await??;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = source;
    blocking(current_status).await
}

/// Distinct titles with dates, capped.
#[tauri::command]
pub async fn common_ground_device_titles(
    source: String,
) -> Result<Vec<CommonGroundDeviceItem>, String> {
    let source = Source::parse(&source)?;
    #[cfg(target_os = "macos")]
    {
        blocking(move || match source {
            Source::Calendar => event_titles(),
            Source::Reminders => reminder_titles(),
        })
        .await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source;
        Err("Calendar and Reminders are available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
fn event_titles() -> Result<Vec<CommonGroundDeviceItem>, String> {
    use kordi_tools::mac_local::MacCalendarEventsRequest;
    // The shared reader allows at most 31 days per request.
    let now = chrono::Local::now().fixed_offset();
    let mut start = now - chrono::Duration::days(30 * MONTHS_BACK);
    let end = now + chrono::Duration::days(30 * MONTHS_AHEAD);
    let mut titles = Vec::new();
    while start < end {
        let stop = (start + chrono::Duration::days(30)).min(end);
        let request = MacCalendarEventsRequest {
            from: start.to_rfc3339(),
            to: stop.to_rfc3339(),
            calendar_ids: Vec::new(),
        };
        let found = super::eventkit::read_events(&request)?;
        titles.extend(collect(&found, "events", "start"));
        start = stop;
    }
    Ok(clean(titles))
}

#[cfg(target_os = "macos")]
fn reminder_titles() -> Result<Vec<CommonGroundDeviceItem>, String> {
    let request = kordi_tools::mac_local::MacRemindersRequest {
        include_completed: true,
    };
    let found = super::eventkit::read_reminders(&request)?;
    Ok(clean(collect(&found, "reminders", "due")))
}

#[cfg(target_os = "macos")]
fn collect(value: &serde_json::Value, key: &str, date_key: &str) -> Vec<CommonGroundDeviceItem> {
    value[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(CommonGroundDeviceItem {
                        title: item["title"].as_str()?.to_string(),
                        date: item[date_key]
                            .as_str()
                            .map(|date| date.chars().take(10).collect()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Keeps the latest date for repeated titles, so a weekly meeting counts once.
fn clean(items: Vec<CommonGroundDeviceItem>) -> Vec<CommonGroundDeviceItem> {
    let mut seen = std::collections::HashMap::new();
    let mut out: Vec<CommonGroundDeviceItem> = Vec::new();
    for item in items {
        let title = item.title.trim().to_string();
        if title.is_empty() {
            continue;
        }
        if let Some(&index) = seen.get(&title.to_lowercase()) {
            let kept: &mut CommonGroundDeviceItem = &mut out[index];
            if item.date > kept.date {
                kept.date = item.date;
            }
            continue;
        }
        seen.insert(title.to_lowercase(), out.len());
        out.push(CommonGroundDeviceItem {
            title,
            date: item.date,
        });
        if out.len() == MAX_TITLES {
            break;
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommonGroundAgentFile {
    /// Path relative to the home directory.
    pub label: String,
    pub text: String,
}

/// Agent instruction and memory files from the home directory, capped.
#[tauri::command]
pub async fn common_ground_agent_files() -> Result<Vec<CommonGroundAgentFile>, String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(Vec::new());
    };
    blocking(move || agent_files(&home)).await
}

fn agent_files(home: &Path) -> Vec<CommonGroundAgentFile> {
    let mut paths = vec![
        home.join(".claude/CLAUDE.md"),
        home.join("AGENTS.md"),
        home.join(".codex/AGENTS.md"),
    ];
    paths.extend(markdown_in(&home.join(".codex/instructions")));
    paths.extend(memory_files(&home.join(".claude/projects")));
    paths
        .iter()
        .filter_map(|path| read_agent_file(home, path))
        .take(MAX_AGENT_FILES)
        .collect()
}

/// `*.md` files directly in `dir`, by name.
fn markdown_in(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

/// `<project>/memory/*.md` without the `MEMORY.md` indexes, newest first.
fn memory_files(projects: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(projects) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path().join("memory")))
        .flat_map(|dir| markdown_in(&dir))
        .filter(|path| path.file_name().is_some_and(|name| name != "MEMORY.md"))
        .map(|path| {
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, path)
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.into_iter().map(|(_, path)| path).collect()
}

fn read_agent_file(home: &Path, path: &Path) -> Option<CommonGroundAgentFile> {
    use std::io::Read;
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    // A character is at most four bytes, so this holds the first 2000 characters.
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take((MAX_AGENT_FILE_CHARS * 4) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let text: String = String::from_utf8_lossy(&bytes)
        .chars()
        .take(MAX_AGENT_FILE_CHARS)
        .collect();
    if text.trim().is_empty() {
        return None;
    }
    let label = path.strip_prefix(home).ok()?.to_string_lossy().into_owned();
    Some(CommonGroundAgentFile { label, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_dedupes_case_insensitively_and_keeps_the_latest_date() {
        let item = |title: &str, date: Option<&str>| CommonGroundDeviceItem {
            title: title.into(),
            date: date.map(Into::into),
        };
        let items = vec![
            item("Lab meeting", Some("2026-05-01")),
            item("lab meeting", Some("2026-09-01")),
            item("Gym", None),
            item("\u{4f1a}\u{8bae}", None),
            item("  ", None),
            item(" Paper review ", None),
        ];
        assert_eq!(
            clean(items),
            vec![
                item("Lab meeting", Some("2026-09-01")),
                item("Gym", None),
                item("\u{4f1a}\u{8bae}", None),
                item("Paper review", None)
            ]
        );
    }

    #[test]
    fn agent_files_reads_known_places_skips_indexes_and_truncates() {
        let home = std::env::temp_dir().join(format!("cg-agent-files-{}", std::process::id()));
        let write = |relative: &str, text: &str| {
            let path = home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("AGENTS.md", &"é".repeat(MAX_AGENT_FILE_CHARS + 50));
        write(".codex/instructions/a.md", "rules");
        write(".codex/instructions/b.txt", "skip");
        write(".claude/projects/p/memory/MEMORY.md", "index");
        write(".claude/projects/p/memory/note.md", "note");
        write(".claude/CLAUDE.md", "  ");
        let files = agent_files(&home);
        std::fs::remove_dir_all(&home).unwrap();
        let labels: Vec<&str> = files.iter().map(|file| file.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "AGENTS.md",
                ".codex/instructions/a.md",
                ".claude/projects/p/memory/note.md"
            ]
        );
        assert_eq!(files[0].text.chars().count(), MAX_AGENT_FILE_CHARS);
    }

    #[test]
    fn unknown_source_is_rejected() {
        assert!(Source::parse("photos").is_err());
    }
}
