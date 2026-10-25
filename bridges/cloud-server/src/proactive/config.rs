//! Sweep timing and limits, with the documented defaults. Each one can be
//! overridden with a `KORDI_PROACTIVE_*` variable.

use chrono::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProactiveConfig {
    /// Seconds between sweeps (`KORDI_PROACTIVE_SWEEP_SECONDS`, 5).
    pub sweep_seconds: u64,
    /// The newest collaborator message must be this old
    /// (`KORDI_PROACTIVE_QUIET_SECONDS`, 60) ...
    pub quiet_seconds: i64,
    /// ... or the oldest new one this old (`KORDI_PROACTIVE_MAX_WAIT_SECONDS`, 180).
    pub max_wait_seconds: i64,
    /// Evaluations per agent in 24 hours (`KORDI_PROACTIVE_DAILY_CAP`, 24).
    pub daily_cap: i64,
    /// Quiet time for a conversation after an offer
    /// (`KORDI_PROACTIVE_COOLDOWN_SECONDS`, 7200).
    pub cooldown_seconds: i64,
}

/// A proposal expires this long after it is made.
pub const PROPOSAL_LIFETIME_HOURS: i64 = 24;

impl Default for ProactiveConfig {
    fn default() -> Self {
        Self {
            sweep_seconds: 5,
            quiet_seconds: 60,
            max_wait_seconds: 180,
            daily_cap: 24,
            cooldown_seconds: 7_200,
        }
    }
}

impl ProactiveConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |key: &str, range: std::ops::RangeInclusive<i64>, default: i64| {
            lookup(key)
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| range.contains(value))
                .unwrap_or(default)
        };
        let defaults = Self::default();
        Self {
            sweep_seconds: read(
                "KORDI_PROACTIVE_SWEEP_SECONDS",
                1..=3_600,
                defaults.sweep_seconds as i64,
            ) as u64,
            quiet_seconds: read(
                "KORDI_PROACTIVE_QUIET_SECONDS",
                0..=86_400,
                defaults.quiet_seconds,
            ),
            max_wait_seconds: read(
                "KORDI_PROACTIVE_MAX_WAIT_SECONDS",
                0..=86_400,
                defaults.max_wait_seconds,
            ),
            daily_cap: read("KORDI_PROACTIVE_DAILY_CAP", 0..=10_000, defaults.daily_cap),
            cooldown_seconds: read(
                "KORDI_PROACTIVE_COOLDOWN_SECONDS",
                0..=604_800,
                defaults.cooldown_seconds,
            ),
        }
    }

    pub fn cooldown(&self) -> Duration {
        Duration::seconds(self.cooldown_seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_document_and_env_overrides_are_bounded() {
        assert_eq!(
            ProactiveConfig::from_lookup(|_| None),
            ProactiveConfig::default()
        );
        let config = ProactiveConfig::from_lookup(|key| match key {
            "KORDI_PROACTIVE_QUIET_SECONDS" => Some("0".into()),
            "KORDI_PROACTIVE_DAILY_CAP" => Some("3".into()),
            "KORDI_PROACTIVE_SWEEP_SECONDS" => Some("0".into()),
            "KORDI_PROACTIVE_COOLDOWN_SECONDS" => Some("soon".into()),
            _ => None,
        });
        assert_eq!(config.quiet_seconds, 0);
        assert_eq!(config.daily_cap, 3);
        assert_eq!(config.sweep_seconds, 5, "out of range keeps the default");
        assert_eq!(config.cooldown_seconds, 7_200);
    }
}
