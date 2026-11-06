//! The shared request rate limiter, built once at startup.

use crate::auth::rate_limit::{
    BudgetOverrides, CloudRateLimitConfig, CloudRateLimiter, TrustedNetworks,
};

use super::logging::redact_url_credentials;
use super::RunError;

/// Redis-backed when `redis_url` is set, in-memory otherwise; trusts the
/// configured networks and applies operator budget overrides.
pub(super) async fn connect(redis_url: Option<&str>) -> Result<CloudRateLimiter, RunError> {
    let trusted_networks = TrustedNetworks::from_env().map_err(RunError::Configuration)?;
    let overrides = BudgetOverrides::from_env().map_err(RunError::InvalidBudgets)?;
    if !overrides.is_empty() {
        println!("Kordi cloud server applying rate-limit budget overrides");
    }
    crate::client_ip::log_startup_configuration();
    let limiter = match redis_url {
        Some(url) => {
            println!(
                "Kordi cloud server connecting to Redis at {}",
                redact_url_credentials(url)
            );
            CloudRateLimiter::redis(url, CloudRateLimitConfig::production())
                .await
                .map_err(RunError::RateLimiter)?
        }
        None => {
            println!("Kordi cloud server starting without Redis (rate limiter is in-memory)");
            CloudRateLimiter::memory(CloudRateLimitConfig::production())
        }
    };
    Ok(limiter
        .with_trusted_networks(trusted_networks)
        .with_budget_overrides(overrides))
}
