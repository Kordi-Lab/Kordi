//! What search and the person page share: the viewer's own state, stored
//! matches between the two nearby profiles, request verdicts, and queueing
//! the matching and checks that are missing.

use std::collections::HashMap;

use axum::response::Response;
use serde_json::{json, Value};
use sqlx_postgres::PgPool;

use super::distance::{band, band_view, within};
use super::evidence::Checked;
use super::needs::{self, Need};
use super::participation::{self, Present};
use super::settings::{self, Settings};
use super::{checks, no_location, off};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::matching::{self, MatchResult, Pending, Queued, SharedCard};

/// The viewer when present, with their settings and active requests.
pub(super) struct Viewer {
    pub me: Present,
    pub settings: Settings,
    pub needs: Vec<Need>,
}

/// The viewer, or the 409 to send: off when they do not participate, no
/// location when they participate without a fresh one.
pub(super) async fn viewer(
    pool: &PgPool,
    account: &str,
) -> sqlx_core::Result<Result<Viewer, Response>> {
    let Some(me) = participation::present(pool, account).await? else {
        return Ok(Err(if participation::participates(pool, account).await? {
            no_location()
        } else {
            off()
        }));
    };
    let settings = settings::load(pool, account, false).await?;
    let needs = needs::active(pool, account).await?;
    Ok(Ok(Viewer {
        me,
        settings,
        needs,
    }))
}

/// Stored matches and verdicts for a set of nearby people.
pub(super) struct Evaluated {
    /// Current matches, by the other profile.
    pub matches: HashMap<String, MatchResult>,
    /// `matching` or `failed` for people without a current match.
    pub unmatched_status: &'static str,
    /// Current verdicts, by (request, other profile).
    pub verdicts: HashMap<(String, String), Checked>,
}

impl Evaluated {
    /// The viewer's active requests this person meets, in range.
    pub fn met<'a>(&self, viewer: &'a Viewer, person: &Present) -> Vec<&'a Need> {
        viewer
            .needs
            .iter()
            .filter(|need| within(person.distance_m, need.range_m))
            .filter(|need| {
                self.verdicts
                    .get(&(need.need_id.clone(), person.profile_id.clone()))
                    .is_some_and(Checked::met)
            })
            .collect()
    }

    /// The status, score and headline shown for a person.
    pub fn summary(&self, person: &Present) -> (&'static str, Option<i64>, Option<String>) {
        match self.matches.get(&person.profile_id) {
            Some(result) => ("ready", Some(result.score), Some(result.headline.clone())),
            None => (self.unmatched_status, None, None),
        }
    }
}

/// Reads what is stored for `people` (nearest first) and queues matching
/// for the nearest unmatched ones and checks for requests without a current
/// verdict. Queued work is charged to the viewer's budgets.
pub(super) async fn evaluate(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &Viewer,
    people: &[Present],
) -> sqlx_core::Result<Evaluated> {
    let mine = viewer.me.shared_card();
    let cards: Vec<SharedCard> = people.iter().map(Present::shared_card).collect();
    let matches = matching::fresh_results(pool, &mine, &cards).await?;
    let unmatched: Vec<SharedCard> = cards
        .into_iter()
        .filter(|card| !matches.contains_key(&card.profile_id))
        .collect();
    let mut unmatched_status = "matching";
    if !unmatched.is_empty() {
        let queued =
            matching::queue_matches(pool, service, rate_limiter, &mine, &unmatched, None).await?;
        if matches!(
            queued,
            Queued::Pending(Pending::Failed) | Queued::Limited(_)
        ) {
            unmatched_status = "failed";
        }
    }
    let refs: Vec<&Present> = people.iter().collect();
    let verdicts = checks::current(pool, &viewer.needs, &refs).await?;
    for need in &viewer.needs {
        let missing: Vec<&Present> = people
            .iter()
            .filter(|person| within(person.distance_m, need.range_m))
            .filter(|person| {
                !verdicts.contains_key(&(need.need_id.clone(), person.profile_id.clone()))
            })
            .collect();
        checks::queue(pool, service, rate_limiter, need, &missing).await?;
    }
    Ok(Evaluated {
        matches,
        unmatched_status,
        verdicts,
    })
}

/// A person's nearby entry, without `relationship`.
pub(super) fn entry(evaluated: &Evaluated, viewer: &Viewer, person: &Present) -> Value {
    let (status, score, headline) = evaluated.summary(person);
    let requests: Vec<Value> = evaluated
        .met(viewer, person)
        .into_iter()
        .map(|need| json!({ "needId": need.need_id, "text": need.text }))
        .collect();
    json!({
        "person": person.person(),
        "distance": band_view(person.distance_m),
        "openTo": person.open_to,
        "status": status,
        "score": score,
        "headline": headline,
        "requests": requests,
    })
}

/// The search order: people who meet a request first, then by score, then
/// by distance band, then by name.
pub(super) fn order_key(
    evaluated: &Evaluated,
    viewer: &Viewer,
    person: &Present,
) -> (bool, std::cmp::Reverse<i64>, i32, String) {
    let meets = !evaluated.met(viewer, person).is_empty();
    let score = evaluated.summary(person).1.unwrap_or(-1);
    let band_max = band(person.distance_m).map_or(i32::MAX, |(_, max)| max);
    (
        !meets,
        std::cmp::Reverse(score),
        band_max,
        person.name.to_lowercase(),
    )
}
