//! The owner's profile view of a card: the latest topics, a timeline, and
//! the references behind each topic.
//!
//! Recency uses ACT-R base-level activation (Anderson and Schooler 1991):
//! `A = ln(sum_j (t_j + 1) ^ -d)`, where `t_j` is the age in months of each
//! supporting item and `d = 0.5`. A topic seen often and recently ranks above
//! one seen once long ago; undated items (the person's own words) count as
//! current.

use std::collections::{BTreeMap, HashSet};

use chrono::{Datelike, NaiveDate};
use serde_json::{json, Map, Value};

use super::card::{Evidence, Topics};

const DECAY: f64 = 0.5;
const LATEST: usize = 6;
const RECENT_DAYS: i64 = 183;

fn parse_day(day: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(day.get(..10)?, "%Y-%m-%d").ok()
}

fn age_months(day: Option<&str>, today: NaiveDate) -> f64 {
    day.and_then(parse_day)
        .map(|then| (today - then).num_days().max(0) as f64 / 30.4)
        .unwrap_or(0.0)
}

pub(super) fn activation(dates: &[Option<&str>], today: NaiveDate) -> Option<f64> {
    if dates.is_empty() {
        return None;
    }
    let sum: f64 = dates
        .iter()
        .map(|day| (age_months(*day, today) + 1.0).powf(-DECAY))
        .sum();
    Some(sum.ln())
}

/// (sort key, label): quarters for the last year, whole years before that.
pub(super) fn period(day: NaiveDate, today: NaiveDate) -> (String, String) {
    let quarter = (day.month0() / 3) + 1;
    if (today - day).num_days() <= 365 {
        (
            format!("{}-{quarter}", day.year()),
            format!("{} Q{quarter}", day.year()),
        )
    } else {
        (format!("{}-0", day.year()), day.year().to_string())
    }
}

struct TopicInfo {
    refs: Vec<String>,
    first_seen: Option<String>,
    last_seen: Option<String>,
    score: Option<f64>,
}

pub(super) fn build(
    topics: &Topics,
    evidence: &[Evidence],
    hidden: &[String],
    today: NaiveDate,
) -> Value {
    let by_id: BTreeMap<&str, &Evidence> = evidence.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut infos: Vec<(String, TopicInfo)> = Vec::new();
    let mut seen = HashSet::new();
    for label in topics.current().chain(topics.earlier.iter()) {
        if !seen.insert(label.clone()) {
            continue;
        }
        let mut items: Vec<&Evidence> = topics
            .refs
            .get(label)
            .into_iter()
            .flatten()
            .filter_map(|id| by_id.get(id.as_str()).copied())
            .collect();
        let mut dated: Vec<&str> = items.iter().filter_map(|e| e.date.as_deref()).collect();
        dated.sort_unstable();
        let dates: Vec<Option<&str>> = items.iter().map(|e| e.date.as_deref()).collect();
        let score = activation(&dates, today).map(|a| (a * 1000.0).round() / 1000.0);
        items.sort_by(|a, b| b.date.cmp(&a.date));
        infos.push((
            label.clone(),
            TopicInfo {
                refs: items.iter().map(|e| e.id.clone()).collect(),
                first_seen: dated.first().map(|d| d.to_string()),
                last_seen: dated.last().map(|d| d.to_string()),
                score,
            },
        ));
    }
    let info = |label: &str| infos.iter().find(|(l, _)| l == label).map(|(_, i)| i);

    let hidden: HashSet<&str> = hidden.iter().map(String::as_str).collect();
    let mut ranked: Vec<&String> = Vec::new();
    for topic in topics.current() {
        if !hidden.contains(topic.as_str()) && !ranked.contains(&topic) {
            ranked.push(topic);
        }
    }
    let score = |topic: &str| info(topic).and_then(|i| i.score).unwrap_or(-9.0);
    ranked.sort_by(|a, b| score(b).total_cmp(&score(a)));
    let cutoff = today - chrono::Duration::days(RECENT_DAYS);
    let recent = |topic: &str| {
        info(topic)
            .and_then(|i| i.last_seen.as_deref())
            .and_then(parse_day)
            .is_none_or(|last| last >= cutoff)
    };
    let latest: Vec<&String> = ranked
        .into_iter()
        .filter(|topic| recent(topic))
        .take(LATEST)
        .collect();

    // Each topic appears once, where it first came up, so the timeline reads
    // as how the work evolved rather than repeating long-lived topics.
    let mut periods: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut by_first: Vec<&(String, TopicInfo)> = infos.iter().collect();
    by_first.sort_by(|a, b| a.1.first_seen.cmp(&b.1.first_seen));
    for (label, info) in by_first {
        if let Some(day) = info.first_seen.as_deref().and_then(parse_day) {
            periods
                .entry(period(day, today))
                .or_default()
                .push(label.clone());
        }
    }
    let timeline: Vec<Value> = periods
        .into_iter()
        .rev()
        .map(|((_, label), topics)| json!({ "period": label, "topics": topics }))
        .collect();

    let mut topic_map = Map::new();
    let mut cited = HashSet::new();
    for (label, info) in &infos {
        cited.extend(info.refs.iter().cloned());
        topic_map.insert(
            label.clone(),
            json!({
                "refs": info.refs,
                "firstSeen": info.first_seen,
                "lastSeen": info.last_seen,
                "score": info.score,
            }),
        );
    }
    let evidence_map: Map<String, Value> = evidence
        .iter()
        .filter(|e| cited.contains(&e.id))
        .map(|e| {
            (
                e.id.clone(),
                json!({
                    "source": e.source,
                    "title": e.title,
                    "date": e.date,
                    "url": e.url,
                    "snippet": e.snippet,
                }),
            )
        })
        .collect();
    json!({
        "latest": latest,
        "earlier": topics.earlier,
        "timeline": timeline,
        "topics": topic_map,
        "evidence": evidence_map,
    })
}
