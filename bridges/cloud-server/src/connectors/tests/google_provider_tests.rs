//! Google Calendar and Gmail against a local HTTP stub (no database).

use super::http_stub::HttpStub;
use super::providers_tests::{http, run};
use super::*;
use crate::connectors::providers::{gmail, google_calendar, ProviderError};

#[tokio::test]
async fn calendar_lists_within_a_window_responds_and_creates() {
    let stub = HttpStub::start().await;
    let provider = google_calendar::provider(http(), Some(stub.base.clone()));
    let too_long = run(
        &provider,
        "calendar_list_events",
        json!({ "timeMin": "2026-10-01T00:00:00Z", "timeMax": "2026-11-05T00:00:00Z" }),
        &json!({}),
    )
    .await;
    assert!(matches!(too_long, Err(ProviderError::InvalidInput(_))));

    let events = (0..70)
        .map(|i| json!({ "id": format!("ev{i}"), "summary": "Standup", "status": "confirmed",
                          "start": { "dateTime": "2026-10-08T09:00:00Z" },
                          "end": { "dateTime": "2026-10-08T09:15:00Z" },
                          "description": "d".repeat(9000),
                          "attendees": [{ "email": "me@example.com", "self": true, "responseStatus": "needsAction" }] }))
        .collect::<Vec<_>>();
    stub.respond(
        "GET",
        "/calendars/primary/events",
        json!({ "items": events, "nextPageToken": "page-2" }),
    );
    let listed = run(
        &provider,
        "calendar_list_events",
        json!({ "timeMin": "2026-10-08T00:00:00Z", "timeMax": "2026-10-15T00:00:00Z" }),
        &json!({}),
    )
    .await
    .unwrap();
    let items = listed["events"].as_array().unwrap();
    assert_eq!(items.len(), 50);
    assert_eq!(items[0]["myResponse"], "needsAction");
    assert_eq!(
        items[0]["description"].as_str().unwrap().chars().count(),
        4003
    );
    assert!(!listed.to_string().contains("page-2"));

    stub.respond(
        "GET",
        "/calendars/primary/events/ev1",
        json!({ "id": "ev1", "summary": "Design review", "attendees": [
            { "email": "lead@example.com", "responseStatus": "accepted" },
            { "email": "me@example.com", "self": true, "responseStatus": "needsAction" }
        ]}),
    );
    stub.respond(
        "PATCH",
        "/calendars/primary/events/ev1",
        json!({ "id": "ev1", "summary": "Design review", "attendees": [
            { "email": "me@example.com", "self": true, "responseStatus": "accepted" }
        ]}),
    );
    let answered = run(
        &provider,
        "calendar_respond",
        json!({ "eventId": "ev1", "response": "accepted" }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(answered["myResponse"], "accepted");
    let patch = &stub.requests_to("PATCH", "/calendars/primary/events/ev1")[0];
    assert!(patch.query.contains("sendUpdates=all"));
    let patched: Value = serde_json::from_str(&patch.body).unwrap();
    assert_eq!(patched["attendees"][1]["responseStatus"], "accepted");
    assert_eq!(patched["attendees"][0]["responseStatus"], "accepted");

    stub.respond(
        "POST",
        "/calendars/primary/events",
        json!({ "id": "new1", "summary": "Focus", "start": { "dateTime": "2026-10-09T10:00:00Z" } }),
    );
    let created = run(
        &provider,
        "calendar_create_event",
        json!({ "summary": "Focus", "start": "2026-10-09T10:00:00Z", "end": "2026-10-09T11:00:00Z",
                "attendees": ["sam@example.com"] }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(created["id"], "new1");
    let bad_attendee = run(
        &provider,
        "calendar_create_event",
        json!({ "summary": "Focus", "start": "2026-10-09T10:00:00Z", "end": "2026-10-09T11:00:00Z",
                "attendees": ["Sam <sam@example.com>"] }),
        &json!({}),
    )
    .await;
    assert!(matches!(bad_attendee, Err(ProviderError::InvalidInput(_))));
}

#[tokio::test]
async fn gmail_searches_reads_and_sends() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let stub = HttpStub::start().await;
    let provider = gmail::provider(http(), Some(stub.base.clone()));
    let ids = (0..30)
        .map(|i| json!({ "id": format!("m{i}") }))
        .collect::<Vec<_>>();
    stub.respond(
        "GET",
        "/messages",
        json!({ "messages": ids, "nextPageToken": "next" }),
    );
    for i in 0..30 {
        stub.respond(
            "GET",
            &format!("/messages/m{i}"),
            json!({ "id": format!("m{i}"), "threadId": "t1", "snippet": "Hello",
                    "payload": { "headers": [{ "name": "From", "value": "alex@example.com" },
                                              { "name": "Subject", "value": "Plan" }],
                                 "mimeType": "multipart/alternative",
                                 "parts": [{ "mimeType": "text/plain",
                                             "body": { "data": URL_SAFE_NO_PAD.encode("b".repeat(9000)) } }] } }),
        );
    }
    let found = run(
        &provider,
        "gmail_search",
        json!({ "query": "is:unread", "maxResults": 100 }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(found["messages"].as_array().unwrap().len(), 25);
    assert_eq!(found["messages"][0]["subject"], "Plan");
    assert!(stub.requests_to("GET", "/messages")[0]
        .query
        .contains("maxResults=25"));

    let message = run(
        &provider,
        "gmail_read_message",
        json!({ "id": "m3" }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(message["from"], "alex@example.com");
    assert_eq!(message["body"].as_str().unwrap().chars().count(), 4003);

    stub.respond(
        "POST",
        "/messages/send",
        json!({ "id": "sent1", "threadId": "t9" }),
    );
    let sent = run(
        &provider,
        "gmail_send",
        json!({ "to": ["sam@example.com"], "subject": "Notes", "body": "See you at 10." }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(sent["id"], "sent1");
    let raw: Value =
        serde_json::from_str(&stub.requests_to("POST", "/messages/send")[0].body).unwrap();
    let decoded = String::from_utf8(
        URL_SAFE_NO_PAD
            .decode(raw["raw"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(decoded.starts_with("To: sam@example.com\r\nSubject: Notes\r\n"));

    for bad in [
        json!({ "to": ["not an email"], "subject": "x", "body": "y" }),
        json!({ "to": ["sam@example.com"], "subject": "x\r\nBcc: evil@example.com", "body": "y" }),
    ] {
        let result = run(&provider, "gmail_send", bad, &json!({})).await;
        assert!(matches!(result, Err(ProviderError::InvalidInput(_))));
    }
}
