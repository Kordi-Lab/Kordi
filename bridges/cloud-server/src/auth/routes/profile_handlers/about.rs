//! The owner's `about` line on their profile (#1945).

use serde::{Deserialize, Deserializer};

/// Characters an `about` line may hold.
pub(crate) const MAX_ABOUT_CHARS: usize = 280;

/// Deserializes a field that may be absent (`None`), null (`Some(None)`), or
/// a string (`Some(Some(_))`). Use with `#[serde(default)]`.
pub(crate) fn present<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// Trims the line; empty clears it. `Err` when it is too long.
pub(crate) fn clean_about(value: Option<&str>) -> Result<Option<String>, ()> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_ABOUT_CHARS {
        return Err(());
    }
    Ok(Some(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_is_trimmed_and_empty_clears_it() {
        assert_eq!(
            clean_about(Some("  Robotics PhD.  ")),
            Ok(Some("Robotics PhD.".into()))
        );
        assert_eq!(clean_about(Some("   ")), Ok(None));
        assert_eq!(clean_about(None), Ok(None));
    }

    #[test]
    fn about_allows_280_characters_and_no_more() {
        let limit = "é".repeat(MAX_ABOUT_CHARS);
        assert_eq!(clean_about(Some(&limit)), Ok(Some(limit.clone())));
        assert_eq!(clean_about(Some(&format!("{limit}a"))), Err(()));
    }
}
