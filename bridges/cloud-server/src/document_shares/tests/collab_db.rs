//! Database tests for collaboration rooms: tickets, the init grant, the
//! socket protocol between two editors, persistence, and snapshot saves.

use std::time::Duration;

use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use yrs::encoding::read::Cursor;
use yrs::sync::MessageReader;
use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

use super::db_fixture::*;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve(f: &Fixture) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = f.app.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("ws://{address}")
}

async fn ticket(f: &Fixture, token: &str) -> Value {
    let uri = format!("/v1/cloud/documents/{}/collab/ticket", f.attachment_id);
    let (status, body) = send(&f.app, "POST", &uri, Some(token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn open(base: &str, ticket: &Value) -> Socket {
    let url = format!(
        "{base}{}?ticket={}",
        ticket["url"].as_str().unwrap(),
        ticket["ticket"].as_str().unwrap()
    );
    connect_async(url).await.unwrap().0
}

/// The next binary frame's messages, or the close code.
async fn next(socket: &mut Socket) -> Result<Vec<Message>, u16> {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame within 5 seconds");
        match frame {
            Some(Ok(WsMessage::Binary(data))) => {
                let mut decoder = DecoderV1::new(Cursor::new(&data));
                return Ok(MessageReader::new(&mut decoder)
                    .map(Result::unwrap)
                    .collect());
            }
            Some(Ok(WsMessage::Close(frame))) => {
                return Err(frame.map_or(1005, |frame| u16::from(frame.code)))
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(1006),
        }
    }
}

/// Opens a socket and completes the sync handshake for `doc`.
async fn join(base: &str, ticket: &Value, doc: &Doc) -> Socket {
    let mut socket = open(base, ticket).await;
    let greeting = next(&mut socket).await.unwrap();
    let Message::Sync(SyncMessage::SyncStep1(server_sv)) = &greeting[0] else {
        panic!("the server opens with sync step 1: {greeting:?}");
    };
    let step2 = doc.transact().encode_state_as_update_v1(server_sv);
    let step1 = doc.transact().state_vector();
    socket
        .send(WsMessage::Binary(
            Message::Sync(SyncMessage::SyncStep2(step2)).encode_v1(),
        ))
        .await
        .unwrap();
    socket
        .send(WsMessage::Binary(
            Message::Sync(SyncMessage::SyncStep1(step1)).encode_v1(),
        ))
        .await
        .unwrap();
    loop {
        for message in next(&mut socket).await.unwrap() {
            if let Message::Sync(SyncMessage::SyncStep2(update)) = message {
                doc.transact_mut()
                    .apply_update(Update::decode_v1(&update).unwrap())
                    .unwrap();
                return socket;
            }
        }
    }
}

fn text_of(doc: &Doc) -> String {
    let text = doc.get_or_insert_text("document");
    text.get_string(&doc.transact())
}

#[tokio::test]
async fn two_editors_sync_updates_and_awareness_then_the_room_compacts() {
    let Some(f) = fixture().await else { return };
    let base = serve(&f).await;
    let alex = Doc::new();
    let priya = Doc::new();
    let mut a = join(&base, &ticket(&f, &f.owner_token).await, &alex).await;
    let mut b = join(&base, &ticket(&f, &f.member_token).await, &priya).await;

    // Alex types; Priya receives the update.
    let update = {
        let text = alex.get_or_insert_text("document");
        let mut txn = alex.transact_mut();
        text.insert(&mut txn, 0, "Field notes");
        txn.encode_update_v1()
    };
    a.send(WsMessage::Binary(
        Message::Sync(SyncMessage::Update(update)).encode_v1(),
    ))
    .await
    .unwrap();
    let received = next(&mut b).await.unwrap();
    let Message::Sync(SyncMessage::Update(change)) = &received[0] else {
        panic!("an update reaches the other editor: {received:?}");
    };
    priya
        .transact_mut()
        .apply_update(Update::decode_v1(change).unwrap())
        .unwrap();
    assert_eq!(text_of(&priya), "Field notes");

    // Alex's awareness reaches Priya unchanged.
    let awareness = Awareness::new(alex.clone());
    awareness
        .set_local_state(
            json!({"user": {"name": "Alex Morgan", "color": "#847ac4", "accountId": f.owner}}),
        )
        .unwrap();
    a.send(WsMessage::Binary(
        Message::Awareness(awareness.update().unwrap()).encode_v1(),
    ))
    .await
    .unwrap();
    let received = next(&mut b).await.unwrap();
    let Message::Awareness(seen) = &received[0] else {
        panic!("awareness reaches the other editor: {received:?}");
    };
    let entry = &seen.clients[&alex.client_id()];
    assert!(entry.json.contains("Alex Morgan"));

    // Alex leaves: Priya sees Alex's awareness cleared.
    a.close(None).await.unwrap();
    let cleared = next(&mut b).await.unwrap();
    let Message::Awareness(cleared) = &cleared[0] else {
        panic!("awareness is cleared on disconnect: {cleared:?}");
    };
    assert_eq!(cleared.clients[&alex.client_id()].json.as_ref(), "null");

    // Unsupported frames close with 4409.
    b.send(WsMessage::Text("hello".into())).await.unwrap();
    assert_eq!(next(&mut b).await.unwrap_err(), 4409);

    // The last leave compacts: state holds everything, updates are trimmed.
    let mut stored = (0_i64, Vec::new(), 1_i64, false);
    for _ in 0..50 {
        stored = query_as(
            "SELECT collab.seq, collab.state, \
                    (SELECT COUNT(*) FROM cloud_document_collab_updates u WHERE u.attachment_id = collab.attachment_id), \
                    collab.initialized_at IS NOT NULL \
             FROM cloud_document_collab collab WHERE attachment_id = $1",
        )
        .bind(&f.attachment_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        if stored.2 == 0 && stored.0 >= 1 && !stored.1.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (seq, state, pending, initialized) = stored;
    assert!(
        seq >= 1 && pending == 0 && initialized,
        "seq {seq}, pending {pending}"
    );
    let restored = Doc::new();
    restored
        .transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    assert_eq!(text_of(&restored), "Field notes");
    let full = restored
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert!(!full.is_empty());

    // A used ticket and a made-up ticket both close with 4401.
    let used = ticket(&f, &f.owner_token).await;
    let mut first = open(&base, &used).await;
    let _ = next(&mut first).await;
    let mut again = open(&base, &used).await;
    assert_eq!(next(&mut again).await.unwrap_err(), 4401);
    let fake = json!({"url": used["url"], "ticket": "kordi_dc_bogus"});
    let mut bogus = open(&base, &fake).await;
    assert_eq!(next(&mut bogus).await.unwrap_err(), 4401);
}

#[tokio::test]
async fn tickets_and_init_follow_the_access_and_grant_rules() {
    let Some(f) = fixture().await else { return };
    let ticket_uri = format!("/v1/cloud/documents/{}/collab/ticket", f.attachment_id);
    let init_uri = format!("/v1/cloud/documents/{}/collab/init", f.attachment_id);
    let (status, _) = send(&f.app, "POST", &ticket_uri, Some(&f.outsider_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let first = ticket(&f, &f.owner_token).await;
    assert!(first["ticket"].as_str().unwrap().starts_with("kordi_dc_"));
    assert_eq!(
        first["url"],
        format!("/v1/cloud/documents/{}/collab", f.attachment_id)
    );
    assert_eq!(first["staleRevision"], false);

    let (_, granted) = send(&f.app, "POST", &init_uri, Some(&f.owner_token), None).await;
    assert_eq!(granted, json!({"initialize": true, "revision": 1}));
    let (_, waiting) = send(&f.app, "POST", &init_uri, Some(&f.member_token), None).await;
    assert_eq!(waiting, json!({"initialize": false}));
    query("UPDATE cloud_document_collab SET init_grant_expires_at = now() - interval '1 second' WHERE attachment_id = $1")
        .bind(&f.attachment_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (_, passed_on) = send(&f.app, "POST", &init_uri, Some(&f.member_token), None).await;
    assert_eq!(passed_on["initialize"], true, "an expired grant passes on");
    query("UPDATE cloud_document_collab SET initialized_at = now() WHERE attachment_id = $1")
        .bind(&f.attachment_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (_, done) = send(&f.app, "POST", &init_uri, Some(&f.owner_token), None).await;
    assert_eq!(done, json!({"initialize": false}));

    // A revisioned save while the room exists marks it stale, once.
    let content_uri = format!("/v1/cloud/documents/{}/content", f.attachment_id);
    let (status, _) = send(
        &f.app,
        "PUT",
        &content_uri,
        Some(&f.owner_token),
        Some(json!({"baseRevision": 1, "source": "# Field notes\n\nOffline edit.\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ticket(&f, &f.member_token).await["staleRevision"], true);
    assert_eq!(ticket(&f, &f.owner_token).await["staleRevision"], false);

    let html_id = format!("att_collab_html_{}", uuid::Uuid::new_v4().simple());
    query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) VALUES ($1, $2, $3, 'text/html', 10, now()::text, now()::text)")
        .bind(&html_id)
        .bind(&f.owner)
        .bind(format!("attachments/{}/{html_id}", f.owner))
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, body) = send(
        &f.app,
        "POST",
        &format!("/v1/cloud/documents/{html_id}/collab/ticket"),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "document_not_collaborative");
}

#[tokio::test]
async fn snapshots_bump_the_revision_only_when_the_markdown_changes() {
    let Some(f) = fixture().await else { return };
    let uri = format!("/v1/cloud/documents/{}/content", f.attachment_id);
    let (_, first) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/documents/{}", f.attachment_id),
        Some(&f.owner_token),
        None,
    )
    .await;
    assert_eq!(first["revision"], 1);
    let (status, same) = send(
        &f.app,
        "PUT",
        &uri,
        Some(&f.member_token),
        Some(json!({"mode": "snapshot", "source": DOCUMENT})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(
        same["revision"], 1,
        "an unchanged snapshot keeps the revision"
    );
    let events = |pool: sqlx_postgres::PgPool, account: String| async move {
        query_as::<_, (Value,)>("SELECT payload FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated' ORDER BY stream_seq")
            .bind(account)
            .fetch_all(&pool)
            .await
            .unwrap()
    };
    assert!(events(f.pool.clone(), f.owner.clone()).await.is_empty());
    let edited = "# Field notes\n\nFirst paragraph, together.\n\nSecond paragraph.\n";
    let (status, bumped) = send(
        &f.app,
        "PUT",
        &uri,
        Some(&f.member_token),
        Some(json!({"mode": "snapshot", "source": edited, "baseRevision": 99})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bumped}");
    assert_eq!(bumped["revision"], 2, "snapshots ignore baseRevision");
    let owner_events = events(f.pool.clone(), f.owner.clone()).await;
    assert_eq!(owner_events.len(), 1);
    assert_eq!(owner_events[0].0["change"], "content");
    assert_eq!(owner_events[0].0["revision"], 2);
    let (status, again) = send(
        &f.app,
        "PUT",
        &uri,
        Some(&f.owner_token),
        Some(json!({"mode": "snapshot", "source": edited})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        again["revision"], 2,
        "a duplicate snapshot from another editor is harmless"
    );
    let (status, body) = send(
        &f.app,
        "PUT",
        &uri,
        Some(&f.owner_token),
        Some(json!({"mode": "merge", "source": edited})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = send(
        &f.app,
        "PUT",
        &uri,
        Some(&f.owner_token),
        Some(json!({"source": edited})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "revisioned saves need baseRevision"
    );
}
