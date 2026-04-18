use std::collections::HashMap;
use std::net::SocketAddr;

use chrono::Utc;

use crate::coord_client::CoordClient;
use crate::crypto;
use crate::mdns;
use crate::noise::{NoiseHandshake, NoiseSession};

/// Connection path to a peer.
#[derive(Debug, Clone)]
pub enum ConnPath {
    Lan(SocketAddr),
    Direct(SocketAddr),
    Derp,
}

/// State machine for peer connection attempts.
#[derive(Debug, Clone)]
pub enum ConnState {
    Idle,
    TryingLan,
    TryingDirect,
    ConnectedLan,
    ConnectedDirect,
    ConnectedRelay,
}

/// Noise session state for a peer.
#[allow(clippy::large_enum_variant)]
pub enum SessionState {
    /// No session established yet.
    None,
    /// Handshake in progress (waiting for response).
    HandshakePending(NoiseHandshake),
    /// Fully established Noise transport session.
    Established(NoiseSession),
}

/// Per-peer connection state.
/// Session keys and nonces are managed by snow inside NoiseSession.
pub struct PeerConn {
    pub state: ConnState,
    pub session: SessionState,
    /// Previous session kept briefly during rekey to decrypt in-flight packets.
    pub previous_session: Option<NoiseSession>,
    /// Expected X25519 public key for this node as resolved from coordination.
    pub expected_x25519_pub: Option<[u8; 32]>,
    pub last_inbound_at: Option<String>,
    pub last_outbound_at: Option<String>,
}

impl PeerConn {
    pub fn new(_peer_id: &str) -> Self {
        Self {
            state: ConnState::Idle,
            session: SessionState::None,
            previous_session: None,
            expected_x25519_pub: None,
            last_inbound_at: None,
            last_outbound_at: None,
        }
    }
}

/// Manages connections to all known peers.
pub struct ConnManager {
    pub peers: HashMap<String, PeerConn>,
    peer_ids_by_wire_id: HashMap<[u8; 20], String>,
    pub coord: Option<CoordClient>,
}

impl ConnManager {
    pub fn new(coord: Option<CoordClient>) -> Self {
        Self {
            peers: HashMap::new(),
            peer_ids_by_wire_id: HashMap::new(),
            coord,
        }
    }

    /// Get or create a PeerConn entry.
    pub fn get_or_create(&mut self, peer_id: &str) -> &mut PeerConn {
        let wire_id = crypto::node_id_wire_id(peer_id);
        self.peer_ids_by_wire_id
            .insert(wire_id, peer_id.to_string());
        self.peers
            .entry(peer_id.to_string())
            .or_insert_with(|| PeerConn::new(peer_id))
    }

    /// Cache the expected X25519 key for a peer as resolved from coordination.
    pub fn remember_peer_identity(&mut self, peer_id: &str, expected_x25519_pub: [u8; 32]) {
        let pc = self.get_or_create(peer_id);
        pc.expected_x25519_pub = Some(expected_x25519_pub);
    }

    /// Forget a peer's cached transport/session identity.
    pub fn forget_peer_identity(&mut self, peer_id: &str) {
        let wire_id = crypto::node_id_wire_id(peer_id);
        self.peer_ids_by_wire_id.remove(&wire_id);
        self.peers.remove(peer_id);
    }

    /// Retain only the listed peer identities in the transport cache.
    pub fn retain_peer_identities(&mut self, retain: &std::collections::HashSet<String>) -> usize {
        let before = self.peers.len();
        self.peers.retain(|peer_id, _| retain.contains(peer_id));
        self.peer_ids_by_wire_id
            .retain(|_, peer_id| retain.contains(peer_id));
        before.saturating_sub(self.peers.len())
    }

    /// Resolve a 20-byte wire ID back to the canonical Bridges node ID.
    pub fn resolve_peer_id(&self, wire_id: &[u8; 20]) -> Option<String> {
        self.peer_ids_by_wire_id.get(wire_id).cloned()
    }

    /// Return the expected X25519 public key for a known peer.
    pub fn expected_peer_key(&self, peer_id: &str) -> Option<[u8; 32]> {
        self.peers
            .get(peer_id)
            .and_then(|pc| pc.expected_x25519_pub)
    }

    pub fn note_inbound(&mut self, peer_id: &str) {
        let pc = self.get_or_create(peer_id);
        pc.last_inbound_at = Some(Utc::now().to_rfc3339());
    }

    pub fn note_outbound(&mut self, peer_id: &str) {
        let pc = self.get_or_create(peer_id);
        pc.last_outbound_at = Some(Utc::now().to_rfc3339());
    }

    /// Try LAN -> direct -> DERP in order, returning the best path found.
    pub async fn connect(&mut self, peer_id: &str) -> Result<ConnPath, String> {
        self.get_or_create(peer_id);

        // 1. Try LAN via mDNS
        if let Some(pc) = self.peers.get_mut(peer_id) {
            pc.state = ConnState::TryingLan;
        }
        let lan_peers = mdns::discover().await;
        for (id, addr) in &lan_peers {
            if id == peer_id {
                let path = ConnPath::Lan(*addr);
                if let Some(pc) = self.peers.get_mut(peer_id) {
                    pc.state = ConnState::ConnectedLan;
                }
                return Ok(path);
            }
        }

        // 2. Try direct via coordination server endpoint hints
        if let Some(pc) = self.peers.get_mut(peer_id) {
            pc.state = ConnState::TryingDirect;
        }
        if let Some(coord) = &self.coord {
            if let Ok(endpoints) = coord.get_peer_endpoints(peer_id).await {
                for ep in &endpoints {
                    if let Ok(addr) = ep.addr.parse::<SocketAddr>() {
                        let path = ConnPath::Direct(addr);
                        if let Some(pc) = self.peers.get_mut(peer_id) {
                            pc.state = ConnState::ConnectedDirect;
                        }
                        return Ok(path);
                    }
                }
            }
        }

        // 3. Fall back to DERP relay
        let path = ConnPath::Derp;
        if let Some(pc) = self.peers.get_mut(peer_id) {
            pc.state = ConnState::ConnectedRelay;
        }
        Ok(path)
    }
}
