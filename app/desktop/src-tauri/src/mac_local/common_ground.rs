//! Common ground preview: lets the card builder ask for Calendar or Reminders
//! access on this Mac and read titles with their dates only (no attendees,
//! places, or notes). Dates let the card show when each topic came up.
//! Nothing is read until the person asks; titles go to the page that asked,
//! which sends them once to build the card.
use serde::Serialize;

use super::{blocking, MacLocalPermission};

const MAX_TITLES: usize = 300;
const MONTHS_BACK: i64 = 6;
const MONTHS_AHEAD: i64 = 2;

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
        if title.chars().count() < 4 {
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
            item(" Paper review ", None),
        ];
        assert_eq!(
            clean(items),
            vec![
                item("Lab meeting", Some("2026-09-01")),
                item("Paper review", None)
            ]
        );
    }

    #[test]
    fn unknown_source_is_rejected() {
        assert!(Source::parse("photos").is_err());
    }
}
