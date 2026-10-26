//! Sweep timing and limits, with the documented defaults. Each one can be
//! overridden with a `KORDI_PERSONAL_AGENT_*` variable.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersonalAgentConfig {
    /// Seconds between sweeps (`KORDI_PERSONAL_AGENT_SWEEP_SECONDS`, 5).
    pub sweep_seconds: u64,
    /// The newest new event must be this old
    /// (`KORDI_PERSONAL_AGENT_QUIET_SECONDS`, 60) ...
    pub quiet_seconds: i64,
    /// ... or the oldest new one this old
    /// (`KORDI_PERSONAL_AGENT_MAX_WAIT_SECONDS`, 300).
    pub max_wait_seconds: i64,
    /// Evaluations per agent in 24 hours
    /// (`KORDI_PERSONAL_AGENT_DAILY_EVALUATIONS`, 48).
    pub daily_evaluations: i64,
    /// Messages per agent in 24 hours (`KORDI_PERSONAL_AGENT_DAILY_SHARES`, 8).
    pub daily_shares: i64,
    /// Quiet time after a message (`KORDI_PERSONAL_AGENT_COOLDOWN_SECONDS`, 1200).
    pub cooldown_seconds: i64,
}

impl Default for PersonalAgentConfig {
    fn default() -> Self {
        Self {
            sweep_seconds: 5,
            quiet_seconds: 60,
            max_wait_seconds: 300,
            daily_evaluations: 48,
            daily_shares: 8,
            cooldown_seconds: 1_200,
        }
    }
}

impl PersonalAgentConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |key: &str, range: std::ops::RangeInclusive<i64>, default: i64| {
            lookup(&format!("KORDI_PERSONAL_AGENT_{key}"))
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| range.contains(value))
                .unwrap_or(default)
        };
        let defaults = Self::default();
        Self {
            sweep_seconds: read("SWEEP_SECONDS", 1..=3_600, defaults.sweep_seconds as i64) as u64,
            quiet_seconds: read("QUIET_SECONDS", 0..=86_400, defaults.quiet_seconds),
            max_wait_seconds: read("MAX_WAIT_SECONDS", 0..=86_400, defaults.max_wait_seconds),
            daily_evaluations: read("DAILY_EVALUATIONS", 0..=10_000, defaults.daily_evaluations),
            daily_shares: read("DAILY_SHARES", 0..=1_000, defaults.daily_shares),
            cooldown_seconds: read("COOLDOWN_SECONDS", 0..=604_800, defaults.cooldown_seconds),
        }
    }
}

/// Consecutive failures after which an evaluation's events are skipped.
pub(super) const MAX_ATTEMPTS: i32 = 5;

/// Retry schedule after a failed evaluation, by consecutive failures, as for
/// proactive evaluations.
pub(super) fn backoff_seconds(attempts: i32) -> i64 {
    match attempts.max(1) {
        1 => 60,
        2 => 300,
        3 => 1_800,
        _ => 7_200,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_document_and_env_overrides_are_bounded() {
        assert_eq!(
            PersonalAgentConfig::from_lookup(|_| None),
            PersonalAgentConfig::default()
        );
        let config = PersonalAgentConfig::from_lookup(|key| match key {
            "KORDI_PERSONAL_AGENT_QUIET_SECONDS" => Some("0".into()),
            "KORDI_PERSONAL_AGENT_DAILY_SHARES" => Some(" 3 ".into()),
            "KORDI_PERSONAL_AGENT_SWEEP_SECONDS" => Some("0".into()),
            "KORDI_PERSONAL_AGENT_COOLDOWN_SECONDS" => Some("soon".into()),
            _ => None,
        });
        assert_eq!(config.quiet_seconds, 0);
        assert_eq!(config.daily_shares, 3);
        assert_eq!(config.sweep_seconds, 5, "out of range keeps the default");
        assert_eq!(config.cooldown_seconds, 1_200);
        assert_eq!(config.max_wait_seconds, 300);
        assert_eq!(config.daily_evaluations, 48);
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_seconds(0), 60);
        assert_eq!(backoff_seconds(2), 300);
        assert_eq!(backoff_seconds(9), 7_200);
    }
}
