//! Matching: what a viewer shares with other people, and the themes of a
//! room. A background run on the Kordi key reads the shared cards and names
//! topic pairs; the server checks every pair against the cards, scores it,
//! and keeps the result for the card revisions it was computed from.

pub(super) mod prompt;
mod routes;
mod store;

pub(super) use routes::{match_detail, recent, results};
pub(super) use store::{complete, fail};

use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::card::{self, Topics};

/// A card as other people may see it: the four lists without hidden topics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharedCard {
    pub account_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub revision: i64,
    pub topics: Topics,
}

/// The shared cards of `accounts` that exist and are shared, in the order
/// given.
pub(super) async fn shared_cards(
    pool: &PgPool,
    accounts: &[String],
) -> sqlx_core::Result<Vec<SharedCard>> {
    let mut out = Vec::new();
    for account in accounts {
        let Some(row) = card::load(pool, account).await? else {
            continue;
        };
        if !row.has_card() || !row.sharing {
            continue;
        }
        let profile: Option<(Option<String>, Option<String>)> =
            query_as("SELECT display_name, avatar_url FROM cloud_accounts WHERE account_id = $1")
                .bind(account)
                .fetch_optional(pool)
                .await?;
        let Some((name, avatar_url)) = profile else {
            continue;
        };
        out.push(SharedCard {
            account_id: account.clone(),
            name: crate::document_shares::access::clean_display_name(name.as_deref()),
            avatar_url,
            revision: row.revision,
            topics: row.shared_topics(),
        });
    }
    Ok(out)
}

/// A topic pair you share, with a short reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Reason {
    pub topic: String,
    pub their_topic: String,
    pub why: String,
}

/// A skill one person offers and the other person's topic it helps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Trade {
    pub topic: String,
    #[serde(rename = "for")]
    pub target: String,
    pub why: String,
}

/// A match as the viewer sees it. Stored per (viewer, other).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MatchResult {
    /// 0-100.
    pub score: i64,
    pub headline: String,
    pub shared: Vec<Reason>,
    pub you_bring: Vec<Trade>,
    pub they_bring: Vec<Trade>,
    pub next_step: String,
}

const WORKING_ON: f64 = 1.0;
const OTHER_FIELD: f64 = 0.6;
const OVERLAP_WEIGHT: f64 = 0.6;
const COMPLEMENT_WEIGHT: f64 = 0.4;

fn weight(topics: &Topics, topic: &str) -> f64 {
    if topics.working_on.iter().any(|t| t == topic) {
        WORKING_ON
    } else {
        OTHER_FIELD
    }
}

/// `1 - e^-x`: a second or third topic still helps, but less than the first.
fn saturate(x: f64) -> f64 {
    1.0 - (-x).exp()
}

/// Shared topics count by list ("working on" more than interests); a skill
/// that serves what the other person is looking for counts in full, one that
/// serves their work or interests a little less.
pub(super) fn score(viewer: &Topics, other: &Topics, found: &prompt::Found) -> i64 {
    let overlap: f64 = found
        .shared
        .iter()
        .map(|r| weight(viewer, &r.topic).min(weight(other, &r.their_topic)))
        .sum();
    let serves = |receiver: &Topics, trade: &Trade| {
        if receiver.looking_for.iter().any(|t| t == &trade.target) {
            WORKING_ON
        } else {
            OTHER_FIELD
        }
    };
    let complement: f64 = found
        .you_bring
        .iter()
        .map(|t| serves(other, t))
        .sum::<f64>()
        + found
            .they_bring
            .iter()
            .map(|t| serves(viewer, t))
            .sum::<f64>();
    let raw = OVERLAP_WEIGHT * saturate(overlap) + COMPLEMENT_WEIGHT * saturate(complement);
    (raw * 100.0).round() as i64
}

pub(super) fn headline(found: &prompt::Found) -> String {
    if let Some(reason) = found.shared.first() {
        reason.their_topic.clone()
    } else if let Some(trade) = found.they_bring.first() {
        format!("Can help with {}", trade.topic)
    } else if let Some(trade) = found.you_bring.first() {
        format!("Needs your {}", trade.topic)
    } else {
        "Different area".into()
    }
}

pub(super) fn result(viewer: &SharedCard, other: &SharedCard, found: prompt::Found) -> MatchResult {
    MatchResult {
        score: score(&viewer.topics, &other.topics, &found),
        headline: headline(&found),
        shared: found.shared,
        you_bring: found.you_bring,
        they_bring: found.they_bring,
        next_step: found.next_step,
    }
}

/// The largest theme with the viewer and at least two others, else the
/// largest one with the viewer.
pub(super) fn suggestion<'a>(
    themes: &'a [(String, Vec<String>)],
    viewer: &str,
) -> Option<&'a (String, Vec<String>)> {
    let mine = themes
        .iter()
        .filter(|(_, people)| people.iter().any(|p| p == viewer));
    let mut best = None;
    for theme in mine {
        if theme.1.len() >= 3 {
            return Some(theme);
        }
        best = best.or(Some(theme));
    }
    best
}
