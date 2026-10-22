//! The match shown on a contact profile: the best stored result between
//! any profile the viewer shares with the contact and any profile the
//! contact shares with the viewer. Nothing new runs here.
//!
//! Only what the match detail would show counts: the two profiles must see
//! each other through a pairing or a room both still share, and both cards
//! must be built and shared. Through a pairing or an open room only a result
//! computed from both current cards counts; through a closed room the last
//! stored result does, as the match detail shows it.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::matching::{shared_cards, MatchResult, SharedCard};
use super::people;

const SHARED: usize = 5;
const TRADES: usize = 3;

struct Candidate {
    fresh: bool,
    computed_at: DateTime<Utc>,
    result: MatchResult,
    viewer: SharedCard,
    other: SharedCard,
}

impl Candidate {
    /// Fresh first, then the higher score, then the newer result.
    fn beats(&self, other: &Candidate) -> bool {
        (self.fresh, self.result.score, self.computed_at)
            > (other.fresh, other.result.score, other.computed_at)
    }
}

/// `commonGround.match` on the profile of `target` as `viewer` sees it, or
/// `None` when no visible match is stored.
pub(crate) async fn contact_match(
    pool: &PgPool,
    viewer: &str,
    target: &str,
) -> sqlx_core::Result<Option<Value>> {
    let mut best: Option<Candidate> = None;
    for link in people::links(pool, viewer, target).await? {
        let pair = [
            (viewer.to_string(), link.viewer_profile.clone()),
            (target.to_string(), link.other_profile.clone()),
        ];
        let cards = shared_cards(pool, &pair).await?;
        let [mine, theirs] = cards.as_slice() else {
            continue;
        };
        let row: Option<(i64, i64, Value, DateTime<Utc>)> = query_as(
            "SELECT viewer_revision, other_revision, result_json, computed_at
             FROM cloud_common_ground_matches
             WHERE viewer_profile_id = $1 AND other_profile_id = $2",
        )
        .bind(&mine.profile_id)
        .bind(&theirs.profile_id)
        .fetch_optional(pool)
        .await?;
        let Some((viewer_revision, other_revision, value, computed_at)) = row else {
            continue;
        };
        let fresh = viewer_revision == mine.revision && other_revision == theirs.revision;
        if link.live && !fresh {
            continue;
        }
        let Ok(result) = serde_json::from_value::<MatchResult>(value) else {
            continue;
        };
        let candidate = Candidate {
            fresh,
            computed_at,
            result,
            viewer: mine.clone(),
            other: theirs.clone(),
        };
        if best.as_ref().is_none_or(|best| candidate.beats(best)) {
            best = Some(candidate);
        }
    }
    Ok(best.map(view))
}

fn view(candidate: Candidate) -> Value {
    let Candidate {
        mut result,
        computed_at,
        viewer,
        other,
        ..
    } = candidate;
    result.shared.truncate(SHARED);
    result.you_bring.truncate(TRADES);
    result.they_bring.truncate(TRADES);
    json!({
        "score": result.score.clamp(0, 100),
        "headline": result.headline,
        "shared": result.shared,
        "youBring": result.you_bring,
        "theyBring": result.they_bring,
        "nextStep": result.next_step,
        "yourProfile": viewer.profile_tag(),
        "theirProfile": other.profile_tag(),
        "updatedAt": computed_at,
    })
}
