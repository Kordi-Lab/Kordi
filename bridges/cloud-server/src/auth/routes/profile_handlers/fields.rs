//! Cleaners for the optional profile fields an owner edits on `PATCH /me`.
//!
//! Each cleaner takes the request's double option: `None` leaves the field
//! unchanged, `Some(None)` or a blank value clears it, and anything else is
//! validated and normalized before it is stored.

use std::str::FromStr;

use chrono::{NaiveDate, Utc};

use super::UpdateProfileRequest;

const ABOUT_MAX_CHARS: usize = 280;
const LOCATION_MAX_CHARS: usize = 80;
const WEBSITE_MAX_CHARS: usize = 200;

/// A rejected profile field: its error code and user-facing message.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct FieldError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

const INVALID_ABOUT: FieldError = FieldError {
    code: "invalid_about",
    message: "Keep About under 280 characters.",
};
const INVALID_LOCATION: FieldError = FieldError {
    code: "invalid_location",
    message: "Keep Location under 80 characters.",
};
const INVALID_TIME_ZONE: FieldError = FieldError {
    code: "invalid_time_zone",
    message: "Choose a time zone from the list.",
};
const INVALID_WEBSITE: FieldError = FieldError {
    code: "invalid_website",
    message: "Enter a valid web address.",
};
const INVALID_BIRTHDAY: FieldError = FieldError {
    code: "invalid_birthday",
    message: "Enter a valid date.",
};

/// The change requested for one field: `None` leaves it alone, `Some(None)`
/// clears it and `Some(Some(value))` stores `value`.
pub(super) type FieldChange<T> = Option<Option<T>>;

/// The profile field changes of one update, already validated.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ProfileFieldChanges {
    pub(super) about: FieldChange<String>,
    pub(super) location: FieldChange<String>,
    pub(super) time_zone: FieldChange<String>,
    pub(super) website: FieldChange<String>,
    pub(super) birthday: FieldChange<NaiveDate>,
}

impl ProfileFieldChanges {
    pub(super) fn from_request(req: &UpdateProfileRequest) -> Result<Self, FieldError> {
        Ok(Self {
            about: clean_with(req.about.as_ref(), clean_about)?,
            location: clean_with(req.location.as_ref(), clean_location)?,
            time_zone: clean_with(req.time_zone.as_ref(), clean_time_zone)?,
            website: clean_with(req.website.as_ref(), clean_website)?,
            birthday: clean_with(req.birthday.as_ref(), |value| {
                clean_birthday(value, Utc::now().date_naive())
            })?,
        })
    }
}

/// Applies `clean` to a present, non-blank value; blank and null both clear.
fn clean_with<T>(
    value: Option<&Option<String>>,
    clean: impl FnOnce(&str) -> Result<T, FieldError>,
) -> Result<FieldChange<T>, FieldError> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(Some(None)),
        Some(trimmed) => clean(trimmed).map(|cleaned| Some(Some(cleaned))),
    }
}

fn clean_about(value: &str) -> Result<String, FieldError> {
    if value.chars().count() > ABOUT_MAX_CHARS {
        return Err(INVALID_ABOUT);
    }
    Ok(value.to_string())
}

fn clean_location(value: &str) -> Result<String, FieldError> {
    if value.chars().count() > LOCATION_MAX_CHARS || value.contains(['\n', '\r']) {
        return Err(INVALID_LOCATION);
    }
    Ok(value.to_string())
}

fn clean_time_zone(value: &str) -> Result<String, FieldError> {
    chrono_tz::Tz::from_str(value)
        .map(|zone| zone.name().to_string())
        .map_err(|_| INVALID_TIME_ZONE)
}

fn clean_website(value: &str) -> Result<String, FieldError> {
    if value.chars().count() > WEBSITE_MAX_CHARS || value.chars().any(char::is_whitespace) {
        return Err(INVALID_WEBSITE);
    }
    let candidate = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let parsed = url::Url::parse(&candidate).map_err(|_| INVALID_WEBSITE)?;
    let has_host = parsed.host_str().is_some_and(|host| !host.is_empty());
    let has_credentials = !parsed.username().is_empty() || parsed.password().is_some();
    if !matches!(parsed.scheme(), "http" | "https") || !has_host || has_credentials {
        return Err(INVALID_WEBSITE);
    }
    let normalized = parsed.to_string();
    if normalized.chars().count() > WEBSITE_MAX_CHARS {
        return Err(INVALID_WEBSITE);
    }
    Ok(normalized)
}

fn clean_birthday(value: &str, today: NaiveDate) -> Result<NaiveDate, FieldError> {
    let earliest = NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid date");
    // `%Y` alone would accept years like "+2000" or five digits.
    if value.len() != 10 {
        return Err(INVALID_BIRTHDAY);
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| INVALID_BIRTHDAY)?;
    if date < earliest || date > today {
        return Err(INVALID_BIRTHDAY);
    }
    Ok(date)
}

/// Deserializes a field whose absence, `null` and value all mean different
/// things: absent → `None`, `null` → `Some(None)`, value → `Some(Some(v))`.
/// Pair it with `#[serde(default)]` so an absent field stays `None`.
pub(in crate::auth::routes) fn double_option<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <Option<String> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    #[test]
    fn blank_and_null_clear_and_absent_leaves_unchanged() {
        assert_eq!(clean_with(None, clean_about), Ok(None));
        assert_eq!(clean_with(Some(&None), clean_about), Ok(Some(None)));
        assert_eq!(clean_with(Some(&some("   ")), clean_about), Ok(Some(None)));
        assert_eq!(
            clean_with(Some(&some("  Hi there  ")), clean_about),
            Ok(Some(Some("Hi there".to_string())))
        );
    }

    #[test]
    fn about_allows_280_characters() {
        assert!(clean_about(&"é".repeat(280)).is_ok());
        assert_eq!(clean_about(&"a".repeat(281)), Err(INVALID_ABOUT));
        assert!(clean_about("Line one\nLine two").is_ok());
    }

    #[test]
    fn location_is_one_short_line() {
        assert_eq!(
            clean_location("Lisbon, Portugal"),
            Ok("Lisbon, Portugal".into())
        );
        assert_eq!(
            clean_location("Lisbon\nSaudi Arabia"),
            Err(INVALID_LOCATION)
        );
        assert_eq!(clean_location(&"a".repeat(81)), Err(INVALID_LOCATION));
        assert!(clean_location(&"a".repeat(80)).is_ok());
    }

    #[test]
    fn time_zone_must_be_a_known_identifier() {
        assert_eq!(clean_time_zone("Asia/Riyadh"), Ok("Asia/Riyadh".into()));
        assert_eq!(clean_time_zone("UTC"), Ok("UTC".into()));
        assert_eq!(clean_time_zone("Mars/Olympus"), Err(INVALID_TIME_ZONE));
        assert_eq!(clean_time_zone("+03:00"), Err(INVALID_TIME_ZONE));
    }

    #[test]
    fn website_gets_a_scheme_and_needs_a_host() {
        assert_eq!(clean_website("kordi.ai"), Ok("https://kordi.ai/".into()));
        assert_eq!(
            clean_website("http://example.com/me"),
            Ok("http://example.com/me".into())
        );
        assert_eq!(
            clean_website("HTTPS://Kordi.AI"),
            Ok("https://kordi.ai/".into())
        );
        for invalid in [
            "javascript:alert(1)",
            "ftp://example.com",
            "https://",
            "not a site",
            "mailto:me@example.com",
        ] {
            assert_eq!(clean_website(invalid), Err(INVALID_WEBSITE), "{invalid}");
        }
        assert_eq!(
            clean_website(&format!("example.com/{}", "a".repeat(200))),
            Err(INVALID_WEBSITE)
        );
    }

    #[test]
    fn birthday_is_a_past_calendar_date() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 20).unwrap();
        assert_eq!(
            clean_birthday("1990-02-28", today),
            Ok(NaiveDate::from_ymd_opt(1990, 2, 28).unwrap())
        );
        assert!(clean_birthday("1900-01-01", today).is_ok());
        assert!(clean_birthday("2026-10-20", today).is_ok());
        for invalid in [
            "2026-10-21",
            "1899-12-31",
            "1990-02-30",
            "1990-2-3",
            "02/03/1990",
            "+1990-02-03",
            "today",
        ] {
            assert_eq!(
                clean_birthday(invalid, today),
                Err(INVALID_BIRTHDAY),
                "{invalid}"
            );
        }
    }

    #[test]
    fn double_option_tells_absent_null_and_value_apart() {
        #[derive(serde::Deserialize)]
        struct Probe {
            #[serde(default, deserialize_with = "double_option")]
            field: Option<Option<String>>,
        }
        let absent: Probe = serde_json::from_str("{}").unwrap();
        let null: Probe = serde_json::from_str(r#"{"field":null}"#).unwrap();
        let value: Probe = serde_json::from_str(r#"{"field":"x"}"#).unwrap();
        assert_eq!(absent.field, None);
        assert_eq!(null.field, Some(None));
        assert_eq!(value.field, Some(Some("x".to_string())));
    }
}
