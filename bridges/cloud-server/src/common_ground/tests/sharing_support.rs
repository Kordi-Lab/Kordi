//! Helpers for the sharing-off tests: switch sharing, and read what one
//! person gets for another as (status, error code).

use serde_json::{json, Value};

use super::db_fixture::send;

pub(super) const CG: &str = "/v1/cloud/common-ground";

/// A status with the error code, if any.
pub(super) type Answer = (u16, Option<String>);

pub(super) fn answer((status, body): (u16, Value)) -> Answer {
    (status, body["errorCode"].as_str().map(str::to_string))
}

/// What a hidden card answers: nothing tells it exists.
pub(super) fn hidden() -> Answer {
    (404, Some("common_ground_person_not_found".into()))
}

/// What you get while your own card on the link is not shared.
pub(super) fn own_off() -> Answer {
    (409, Some("common_ground_sharing_off".into()))
}

pub(super) async fn set_sharing(app: &axum::Router, token: &str, profile: Option<&str>, on: bool) {
    let body = json!({"profileId": profile, "sharing": on});
    let (status, body) = send(app, "PUT", &format!("{CG}/settings"), token, Some(body)).await;
    assert_eq!(status, 200, "{body}");
}

fn through(profile: Option<&str>) -> String {
    profile.map(|p| format!("?profile={p}")).unwrap_or_default()
}

/// `people/:id` as `token` sees `other`, through `profile` when given.
pub(super) async fn card(
    app: &axum::Router,
    token: &str,
    other: &str,
    profile: Option<&str>,
) -> (u16, Value) {
    let path = format!("{CG}/people/{other}{}", through(profile));
    send(app, "GET", &path, token, None).await
}

/// `people/:id` and `people/:id/match` as `token` sees `other`.
pub(super) async fn card_and_match(
    app: &axum::Router,
    token: &str,
    other: &str,
    profile: Option<&str>,
) -> [Answer; 2] {
    let detail = format!("{CG}/people/{other}/match{}", through(profile));
    [
        answer(card(app, token, other, profile).await),
        answer(send(app, "GET", &detail, token, None).await),
    ]
}

/// Add, Chat and Meet from `token` to `other`.
pub(super) async fn follow_through(app: &axum::Router, token: &str, other: &str) -> Vec<Answer> {
    let mut out = Vec::new();
    for action in ["contact", "chat", "meet"] {
        let path = format!("{CG}/people/{other}/{action}");
        out.push(answer(send(app, "POST", &path, token, None).await));
    }
    out
}

/// Account ids in `token`'s Recent, newest first.
pub(super) async fn recent_ids(app: &axum::Router, token: &str) -> Vec<String> {
    let (status, body) = send(app, "GET", &format!("{CG}/recent"), token, None).await;
    assert_eq!(status, 200, "{body}");
    ids(&body["people"], "person")
}

/// The account ids in a list of people, each under `key` (or the entry
/// itself when `key` is empty).
pub(super) fn ids(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|entry| if key.is_empty() { entry } else { &entry[key] })
        .map(|person| person["accountId"].as_str().unwrap().to_string())
        .collect()
}

/// `commonGround` on `token`'s contact profile of `other`.
pub(super) async fn contact_grounding(app: &axum::Router, token: &str, other: &str) -> Value {
    let path = format!("/v1/cloud/contacts/{other}/profile");
    let (status, body) = send(app, "GET", &path, token, None).await;
    assert_eq!(status, 200, "{body}");
    body["commonGround"].clone()
}

pub(super) async fn results(app: &axum::Router, code: &str, token: &str) -> (u16, Value) {
    let path = format!("{CG}/rooms/{code}/results");
    send(app, "POST", &path, token, None).await
}

/// (account id, hasCard) for each member of the lobby `token` sees.
pub(super) async fn lobby(app: &axum::Router, code: &str, token: &str) -> Vec<(String, bool)> {
    let (status, body) = send(app, "GET", &format!("{CG}/rooms/{code}"), token, None).await;
    assert_eq!(status, 200, "{body}");
    body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let id = m["accountId"].as_str().unwrap().to_string();
            (id, m["hasCard"].as_bool().unwrap())
        })
        .collect()
}

/// Each room topic with the account ids of its people.
pub(super) fn topics(results: &Value) -> Vec<(String, Vec<String>)> {
    results["topics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let label = t["label"].as_str().unwrap().to_string();
            (label, ids(&t["people"], ""))
        })
        .collect()
}
