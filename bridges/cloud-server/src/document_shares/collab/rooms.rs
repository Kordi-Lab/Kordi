//! In-memory collaboration rooms: one Y document per canonical attachment,
//! the awareness states of its editors, and a broadcast channel to them.
//!
//! The server speaks y-protocols sync v1 and awareness, as `y-websocket`
//! does. Client updates are applied to the room's document; only the changes
//! the document actually took (as reported by its update observer) are
//! appended to storage and broadcast. The room compacts its state every
//! [`COMPACT_EVERY_UPDATES`] updates or [`COMPACT_EVERY`], and when the last
//! editor leaves. Single replica: rooms live in this process.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use sqlx_postgres::PgPool;
use tokio::sync::{broadcast, Mutex, RwLock};
use yrs::block::ClientID;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::{MessageReader, SyncMessage};
use yrs::sync::{Awareness, Message};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use super::store;

pub(crate) const COMPACT_EVERY_UPDATES: u32 = 200;
pub(crate) const COMPACT_EVERY: Duration = Duration::from_secs(5 * 60);
const BROADCAST_CAPACITY: usize = 512;

/// A frame for every connection of the room except `from`.
#[derive(Debug, Clone)]
pub(crate) struct Outgoing {
    pub from: u64,
    pub frame: Arc<Vec<u8>>,
}

#[derive(Debug)]
pub(crate) enum RoomError {
    Database(sqlx_core::Error),
    /// The stored state or a client message could not be decoded or applied.
    Invalid,
}

impl From<sqlx_core::Error> for RoomError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

struct RoomState {
    awareness: Awareness,
    /// Changes the document took in the current message, from its observer.
    taken: Arc<StdMutex<Vec<Vec<u8>>>>,
    /// Keeps the update observer alive for the room's lifetime.
    _subscription: yrs::Subscription,
    seq: i64,
    initialized: bool,
    since_compaction: u32,
    last_compaction: Instant,
    connections: usize,
}

pub(crate) struct Room {
    pub attachment_id: String,
    state: Mutex<RoomState>,
    tx: broadcast::Sender<Outgoing>,
}

#[derive(Default)]
pub struct RoomRegistry {
    rooms: RwLock<HashMap<String, Arc<Room>>>,
}

impl RoomRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Joins the room for `attachment_id`, loading it from storage when no
    /// one is connected.
    pub(crate) async fn join(
        &self,
        pool: &PgPool,
        attachment_id: &str,
    ) -> Result<Arc<Room>, RoomError> {
        {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(attachment_id) {
                room.state.lock().await.connections += 1;
                return Ok(room.clone());
            }
        }
        let loaded = Arc::new(Room::load(pool, attachment_id).await?);
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(attachment_id.to_string())
            .or_insert(loaded)
            .clone();
        room.state.lock().await.connections += 1;
        Ok(room)
    }

    /// Leaves the room: clears the connection's awareness states for the
    /// others, and on the last leave compacts and unloads the room.
    pub(crate) async fn leave(
        &self,
        pool: &PgPool,
        room: &Arc<Room>,
        conn: u64,
        clients: &HashSet<ClientID>,
    ) {
        let last = {
            let mut state = room.state.lock().await;
            for client in clients {
                state.awareness.remove_state(*client);
            }
            if !clients.is_empty() {
                if let Ok(update) = state.awareness.update_with_clients(clients.iter().copied()) {
                    room.broadcast(conn, Message::Awareness(update).encode_v1());
                }
            }
            state.connections = state.connections.saturating_sub(1);
            if state.connections == 0 {
                if let Err(error) = room.compact_locked(pool, &mut state).await {
                    eprintln!("[document-collab] compact on leave: {error:?}");
                }
            }
            state.connections == 0
        };
        if last {
            let mut rooms = self.rooms.write().await;
            let still_empty = room.state.lock().await.connections == 0;
            if still_empty
                && rooms
                    .get(&room.attachment_id)
                    .is_some_and(|current| Arc::ptr_eq(current, room))
            {
                rooms.remove(&room.attachment_id);
            }
        }
    }
}

impl Room {
    async fn load(pool: &PgPool, attachment_id: &str) -> Result<Self, RoomError> {
        let stored = store::load_room(pool, attachment_id).await?;
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            for bytes in std::iter::once(&stored.state)
                .chain(stored.updates.iter().map(|(_, update)| update))
                .filter(|bytes| !bytes.is_empty())
            {
                let update = Update::decode_v1(bytes).map_err(|_| RoomError::Invalid)?;
                txn.apply_update(update).map_err(|_| RoomError::Invalid)?;
            }
        }
        let taken = Arc::new(StdMutex::new(Vec::new()));
        let sink = taken.clone();
        let subscription = doc
            .observe_update_v1(move |_, event| {
                if let Ok(mut taken) = sink.lock() {
                    taken.push(event.update.clone());
                }
            })
            .map_err(|_| RoomError::Invalid)?;
        let seq = stored.updates.last().map_or(stored.seq, |(seq, _)| *seq);
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Ok(Self {
            attachment_id: attachment_id.to_string(),
            state: Mutex::new(RoomState {
                awareness: Awareness::new(doc),
                taken,
                _subscription: subscription,
                seq,
                initialized: stored.initialized,
                since_compaction: stored.updates.len() as u32,
                last_compaction: Instant::now(),
                connections: 0,
            }),
            tx,
        })
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Outgoing> {
        self.tx.subscribe()
    }

    fn broadcast(&self, from: u64, frame: Vec<u8>) {
        let _ = self.tx.send(Outgoing {
            from,
            frame: Arc::new(frame),
        });
    }

    /// The server's opening messages: sync step 1 and the current awareness.
    pub(crate) async fn greeting(&self) -> Vec<Vec<u8>> {
        let state = self.state.lock().await;
        let sv = state.awareness.doc().transact().state_vector();
        let mut frames = vec![Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1()];
        if let Ok(update) = state.awareness.update() {
            if !update.clients.is_empty() {
                frames.push(Message::Awareness(update).encode_v1());
            }
        }
        frames
    }

    /// Handles one binary frame from connection `conn`. Returns the replies
    /// for that connection; changes go to the others through the channel.
    /// Awareness client ids the connection announces are added to `clients`.
    pub(crate) async fn handle(
        &self,
        pool: &PgPool,
        conn: u64,
        data: &[u8],
        clients: &mut HashSet<ClientID>,
    ) -> Result<Vec<Vec<u8>>, RoomError> {
        let messages = decode_messages(data)?;
        let mut state = self.state.lock().await;
        let mut replies = Vec::new();
        for message in messages {
            match message {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let update = state
                        .awareness
                        .doc()
                        .transact()
                        .encode_state_as_update_v1(&sv);
                    replies.push(Message::Sync(SyncMessage::SyncStep2(update)).encode_v1());
                }
                Message::Sync(SyncMessage::SyncStep2(bytes))
                | Message::Sync(SyncMessage::Update(bytes)) => {
                    self.apply_locked(pool, &mut state, conn, &bytes).await?;
                }
                Message::Awareness(update) => {
                    clients.extend(update.clients.keys().copied());
                    let frame = Message::Awareness(update.clone()).encode_v1();
                    state
                        .awareness
                        .apply_update(update)
                        .map_err(|_| RoomError::Invalid)?;
                    self.broadcast(conn, frame);
                }
                Message::AwarenessQuery => {
                    let update = state.awareness.update().map_err(|_| RoomError::Invalid)?;
                    replies.push(Message::Awareness(update).encode_v1());
                }
                Message::Auth(_) | Message::Custom(_, _) => return Err(RoomError::Invalid),
            }
        }
        Ok(replies)
    }

    async fn apply_locked(
        &self,
        pool: &PgPool,
        state: &mut RoomState,
        conn: u64,
        bytes: &[u8],
    ) -> Result<(), RoomError> {
        let update = Update::decode_v1(bytes).map_err(|_| RoomError::Invalid)?;
        {
            let mut txn = state.awareness.doc().transact_mut();
            txn.apply_update(update).map_err(|_| RoomError::Invalid)?;
        }
        let taken: Vec<Vec<u8>> = state
            .taken
            .lock()
            .map(|mut taken| std::mem::take(&mut *taken))
            .unwrap_or_default();
        for change in taken {
            state.seq += 1;
            store::append_update(pool, &self.attachment_id, state.seq, &change).await?;
            state.since_compaction += 1;
            if !state.initialized {
                store::mark_initialized(pool, &self.attachment_id).await?;
                state.initialized = true;
            }
            self.broadcast(conn, Message::Sync(SyncMessage::Update(change)).encode_v1());
        }
        if state.since_compaction >= COMPACT_EVERY_UPDATES
            || (state.since_compaction > 0 && state.last_compaction.elapsed() >= COMPACT_EVERY)
        {
            self.compact_locked(pool, state).await?;
        }
        Ok(())
    }

    async fn compact_locked(&self, pool: &PgPool, state: &mut RoomState) -> Result<(), RoomError> {
        let (snapshot, state_vector) = {
            let txn = state.awareness.doc().transact();
            (
                txn.encode_state_as_update_v1(&StateVector::default()),
                txn.state_vector().encode_v1(),
            )
        };
        store::compact(
            pool,
            &self.attachment_id,
            &snapshot,
            &state_vector,
            state.seq,
        )
        .await?;
        state.since_compaction = 0;
        state.last_compaction = Instant::now();
        Ok(())
    }
}

/// Decodes every message in a frame; anything malformed is unsupported.
pub(crate) fn decode_messages(data: &[u8]) -> Result<Vec<Message>, RoomError> {
    let mut decoder = DecoderV1::new(Cursor::new(data));
    let reader = MessageReader::new(&mut decoder);
    let mut messages = Vec::new();
    for message in reader {
        messages.push(message.map_err(|_| RoomError::Invalid)?);
    }
    if messages.is_empty() {
        return Err(RoomError::Invalid);
    }
    Ok(messages)
}
