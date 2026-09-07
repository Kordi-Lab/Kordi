use super::models::{normalize_event_times, validate_event, CalendarEvent};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recurrence {
    pub frequency: String,
    #[serde(default = "one")]
    pub interval: u32,
    #[serde(default)]
    pub weekdays: Vec<u32>,
    pub timezone: String,
    pub count: Option<usize>,
    pub until: Option<String>,
}
fn one() -> u32 {
    1
}

pub fn validate(rule: &Recurrence, require_end: bool) -> Result<(), &'static str> {
    if !["daily", "weekly", "monthly", "yearly"].contains(&rule.frequency.as_str())
        || !(1..=99).contains(&rule.interval)
        || rule.timezone.is_empty()
        || rule.timezone.len() > 100
        || rule.weekdays.len() > 7
        || rule.weekdays.iter().any(|day| !(1..=7).contains(day))
        || (rule.frequency != "weekly" && !rule.weekdays.is_empty())
        || rule.count.is_some_and(|count| !(1..=250).contains(&count))
        || (rule.count.is_some() && rule.until.is_some())
        || (require_end && rule.count.is_none() && rule.until.is_none())
        || rule
            .until
            .as_ref()
            .is_some_and(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err())
    {
        return Err("Review a daily, weekly, monthly or yearly rule, with an end date or up to 250 occurrences.");
    }
    Ok(())
}

fn dates(rule: &Recurrence, start: NaiveDate) -> Result<Vec<NaiveDate>, &'static str> {
    validate(rule, true)?;
    // ponytail: finite reviewed series, up to five years; add rolling expansion only when requested.
    let horizon = start
        .checked_add_months(chrono::Months::new(60))
        .ok_or("Invalid series date.")?;
    let until = rule
        .until
        .as_ref()
        .map(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d"))
        .transpose()
        .map_err(|_| "Invalid series end date.")?
        .unwrap_or(horizon);
    if until < start || until > horizon {
        return Err("Choose a series end within five years after the start.");
    }
    let mut dates = Vec::new();
    let monday = start - Duration::days(start.weekday().num_days_from_monday().into());
    let weekdays = if rule.weekdays.is_empty() {
        vec![start.weekday().number_from_monday()]
    } else {
        rule.weekdays.clone()
    };
    for offset in 0..=(until - start).num_days() {
        let day = start + Duration::days(offset);
        let month_delta =
            (day.year() - start.year()) * 12 + day.month() as i32 - start.month() as i32;
        let matches = match rule.frequency.as_str() {
            "daily" => offset % i64::from(rule.interval) == 0,
            "weekly" => {
                ((day - monday).num_days() / 7) % i64::from(rule.interval) == 0
                    && weekdays.contains(&day.weekday().number_from_monday())
            }
            "monthly" => month_delta % rule.interval as i32 == 0 && day.day() == start.day(),
            "yearly" => {
                (day.year() - start.year()) % rule.interval as i32 == 0
                    && day.month() == start.month()
                    && day.day() == start.day()
            }
            _ => false,
        };
        if matches {
            dates.push(day);
        }
        if dates.len() == rule.count.unwrap_or(251) {
            break;
        }
    }
    if dates.is_empty() || dates.len() > 250 || rule.count.is_some_and(|count| dates.len() != count)
    {
        return Err("The rule must produce 1–250 occurrences within five years.");
    }
    Ok(dates)
}

pub async fn expand(
    pool: &PgPool,
    mut base: CalendarEvent,
) -> Result<Vec<CalendarEvent>, &'static str> {
    normalize_event_times(&mut base)?;
    validate_event(&base)?;
    let rule = base
        .recurrence
        .as_ref()
        .ok_or("Choose a repeat rule before previewing the series.")?;
    validate(rule, true)?;
    if base.revision != 0 || base.id.len() > 260 {
        return Err("Review a new series before saving it.");
    }
    if base
        .timezone
        .as_ref()
        .is_some_and(|zone| zone != &rule.timezone)
    {
        return Err("Event and recurrence timezones must match.");
    }
    let valid: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
        .bind(&rule.timezone)
        .fetch_one(pool)
        .await
        .map_err(|_| "Could not validate the timezone.")?;
    if !valid.0 {
        return Err("Choose a valid IANA timezone.");
    }
    let start = DateTime::parse_from_rfc3339(&base.start_at)
        .map_err(|_| "Invalid start time.")?
        .with_timezone(&Utc);
    let zone = if base.all_day { "UTC" } else { &rule.timezone };
    let (local,): (NaiveDateTime,) = query_as("SELECT $1::timestamptz AT TIME ZONE $2")
        .bind(start)
        .bind(zone)
        .fetch_one(pool)
        .await
        .map_err(|_| "Could not resolve the event time.")?;
    let walls: Vec<_> = dates(rule, local.date())?
        .into_iter()
        .map(|date| date.and_time(local.time()))
        .collect();
    let instants: Vec<(NaiveDateTime, DateTime<Utc>, bool)> = query_as("SELECT wall_time,wall_time AT TIME ZONE $2,(wall_time AT TIME ZONE $2) AT TIME ZONE $2 = wall_time FROM unnest($1::timestamp[]) AS occurrence(wall_time) ORDER BY wall_time")
        .bind(walls).bind(zone).fetch_all(pool).await.map_err(|_| "Could not expand the repeat rule.")?;
    // Do not silently move a nonexistent spring-forward time. Ask the user to review a valid time.
    if instants.iter().any(|row| !row.2) {
        return Err(
            "An occurrence falls in a daylight-saving time gap. Choose another meeting time.",
        );
    }
    let duration = base
        .end_at
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| "Invalid end time.")?
        .map(|end| end.with_timezone(&Utc) - start);
    let reminder = base
        .reminder_at
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| "Invalid reminder time.")?
        .map(|time| time.with_timezone(&Utc) - start);
    instants
        .into_iter()
        .enumerate()
        .map(|(index, (wall, instant, _))| {
            // Preserve the reviewed instant when the anchor is in a repeated autumn hour.
            let instant = if wall == local { start } else { instant };
            let mut event = base.clone();
            event.id = if index == 0 {
                base.id.clone()
            } else {
                format!("{}:occurrence:{}", base.id, index + 1)
            };
            event.series_id = Some(base.id.clone());
            event.timezone = Some(rule.timezone.clone());
            event.start_at = instant.to_rfc3339();
            event.end_at = duration.map(|duration| (instant + duration).to_rfc3339());
            event.reminder_at = reminder.map(|offset| (instant + offset).to_rfc3339());
            validate_event(&event)?;
            Ok(event)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeat_dates_preserve_weekdays_and_skip_missing_month_days() {
        let mut rule = Recurrence {
            frequency: "weekly".into(),
            interval: 2,
            weekdays: vec![1, 3],
            timezone: "Asia/Riyadh".into(),
            count: Some(4),
            until: None,
        };
        let start = NaiveDate::from_ymd_opt(2026, 9, 7).unwrap();
        assert_eq!(
            dates(&rule, start)
                .unwrap()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            ["2026-09-07", "2026-09-09", "2026-09-21", "2026-09-23"]
        );
        rule.frequency = "monthly".into();
        rule.interval = 1;
        rule.weekdays.clear();
        rule.count = Some(3);
        assert_eq!(
            dates(&rule, NaiveDate::from_ymd_opt(2026, 1, 31).unwrap())
                .unwrap()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            ["2026-01-31", "2026-03-31", "2026-05-31"]
        );
        rule.count = None;
        assert!(validate(&rule, false).is_ok());
        assert!(validate(&rule, true).is_err());
    }
}
