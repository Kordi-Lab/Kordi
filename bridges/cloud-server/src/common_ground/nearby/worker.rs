//! The alert sweep: every `KORDI_COMMON_GROUND_NEARBY_SWEEP_SECONDS` it
//! claims dirty accounts, queues their alerts and missing runs, then
//! delivers pending alerts. It runs only when Grounding is available.

use std::sync::Arc;
use std::time::Duration;

use sqlx_postgres::PgPool;

use super::alerts::{self, Queueing};
use super::config;
use super::delivery::{self, Outcome};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::notifications::PushNotificationService;
use crate::server::ServerState;

/// Claims one sweep takes at most, so a backlog cannot hold delivery up.
const MAX_CLAIMS: usize = 50;

pub(in crate::common_ground) fn spawn(
    state: Arc<ServerState>,
    rate_limiter: Arc<CloudRateLimiter>,
) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(config().sweep_seconds));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let Some(pip) = state.pip() else {
                continue;
            };
            let swept = sweep_once(
                state.db_pool(),
                pip.config(),
                &rate_limiter,
                state.notifications(),
            )
            .await;
            if let Err(error) = swept {
                eprintln!(
                    "[common-ground] Nearby sweep failed; retrying on the next tick: {error}"
                );
            }
        }
    });
}

/// One sweep: expires old pending alerts, claims dirty accounts until none
/// are left and queues what each calls for, then delivers pending alerts.
/// Returns each delivery outcome.
pub(in crate::common_ground) async fn sweep_once(
    pool: &PgPool,
    service: &crate::pip::PipConfig,
    rate_limiter: &CloudRateLimiter,
    push: Option<&PushNotificationService>,
) -> sqlx_core::Result<Vec<(String, Outcome)>> {
    let ctx = Queueing {
        pool,
        service,
        rate_limiter,
    };
    delivery::expire(pool).await?;
    for _ in 0..MAX_CLAIMS {
        let claimed = alerts::claim(pool).await?;
        if claimed.is_empty() {
            break;
        }
        for account in claimed {
            // One account's failure does not hold up the others; its next
            // location post marks it again.
            if let Err(error) = alerts::queue_for(&ctx, &account).await {
                eprintln!("[common-ground] Nearby alerts for one account failed: {error}");
            }
        }
    }
    delivery::deliver(pool, push).await
}
