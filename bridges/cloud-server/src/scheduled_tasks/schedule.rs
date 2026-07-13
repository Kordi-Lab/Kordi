use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduledTaskSchedule {
    Once {
        at: String,
    },
    Daily {
        time: String,
        timezone: Option<String>,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("scheduled time must be a valid RFC3339 timestamp")]
    InvalidOnceAt,
    #[error("daily time must use HH:MM 24-hour format")]
    InvalidDailyTime,
    #[error("timezone is not supported in this build")]
    UnsupportedTimezone,
}

pub fn initial_next_run_at(
    schedule: &ScheduledTaskSchedule,
    created_at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    match schedule {
        ScheduledTaskSchedule::Once { at } => {
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| ScheduleError::InvalidOnceAt)?
                .with_timezone(&Utc);
            Ok(Some(if at > created_at { at } else { created_at }))
        }
        ScheduledTaskSchedule::Daily { .. } => next_run_after(schedule, created_at),
    }
}

pub fn next_run_after(
    schedule: &ScheduledTaskSchedule,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    match schedule {
        ScheduledTaskSchedule::Once { at } => {
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| ScheduleError::InvalidOnceAt)?
                .with_timezone(&Utc);
            Ok((at > after).then_some(at))
        }
        ScheduledTaskSchedule::Daily { time, timezone } => {
            if timezone
                .as_deref()
                .filter(|value| *value != "UTC")
                .is_some()
            {
                return Err(ScheduleError::UnsupportedTimezone);
            }
            let time = NaiveTime::parse_from_str(time, "%H:%M")
                .map_err(|_| ScheduleError::InvalidDailyTime)?;
            let today = after.date_naive();
            let candidate = Utc
                .with_ymd_and_hms(
                    today.year(),
                    today.month(),
                    today.day(),
                    time.hour(),
                    time.minute(),
                    0,
                )
                .single()
                .ok_or(ScheduleError::InvalidDailyTime)?;
            if candidate > after {
                Ok(Some(candidate))
            } else {
                Ok(Some(candidate + Duration::days(1)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{initial_next_run_at, next_run_after, ScheduleError, ScheduledTaskSchedule};
    use chrono::{TimeZone, Utc};

    #[test]
    fn once_schedule_returns_future_instant_and_none_after_it_passes() {
        let schedule = ScheduledTaskSchedule::Once {
            at: "2026-06-09T14:30:00Z".to_string(),
        };
        assert_eq!(
            next_run_after(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 14, 0, 0).unwrap()
            )
            .unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 0).unwrap())
        );
        assert_eq!(
            next_run_after(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 14, 31, 0).unwrap()
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn initial_once_schedule_at_or_before_creation_time_runs_immediately() {
        let schedule = ScheduledTaskSchedule::Once {
            at: "2026-06-09T14:30:00Z".to_string(),
        };
        assert_eq!(
            initial_next_run_at(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 1).unwrap()
            )
            .unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 1).unwrap())
        );
        assert_eq!(
            initial_next_run_at(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 0).unwrap()
            )
            .unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 14, 30, 0).unwrap())
        );
    }

    #[test]
    fn daily_schedule_rolls_to_today_or_tomorrow_in_utc() {
        let schedule = ScheduledTaskSchedule::Daily {
            time: "09:00".to_string(),
            timezone: Some("UTC".to_string()),
        };
        assert_eq!(
            next_run_after(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 8, 45, 0).unwrap()
            )
            .unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 9, 9, 0, 0).unwrap())
        );
        assert_eq!(
            next_run_after(
                &schedule,
                Utc.with_ymd_and_hms(2026, 6, 9, 9, 1, 0).unwrap()
            )
            .unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 6, 10, 9, 0, 0).unwrap())
        );
    }

    #[test]
    fn daily_schedule_rejects_invalid_time_and_non_utc_timezone_for_mvp() {
        let bad_time = ScheduledTaskSchedule::Daily {
            time: "morning".to_string(),
            timezone: Some("UTC".to_string()),
        };
        assert_eq!(
            next_run_after(
                &bad_time,
                Utc.with_ymd_and_hms(2026, 6, 9, 8, 0, 0).unwrap()
            )
            .unwrap_err(),
            ScheduleError::InvalidDailyTime
        );
        let local_zone = ScheduledTaskSchedule::Daily {
            time: "09:00".to_string(),
            timezone: Some("America/Los_Angeles".to_string()),
        };
        assert_eq!(
            next_run_after(
                &local_zone,
                Utc.with_ymd_and_hms(2026, 6, 9, 8, 0, 0).unwrap()
            )
            .unwrap_err(),
            ScheduleError::UnsupportedTimezone
        );
    }
}
