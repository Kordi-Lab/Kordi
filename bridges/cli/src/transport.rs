use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::sync::Mutex;

use crate::connmgr::{ConnManager, ConnPath, SessionState};
use crate::crypto;
use crate::derp_client::DerpClient;
use crate::noise;

/// Unified encrypted transport using Noise IK handshake.
pub struct Transport {
    pub conn: Arc<Mutex<ConnManager>>,
    pub derp: Option<Arc<DerpClient>>,
    pub my_node_id: String,
    pub my_x25519_priv: [u8; 32],
    udp: Option<Arc<UdpSocket>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RawPacketSource {
    Derp(String),
    Udp,
}

/// Verified source identity for an inbound transport packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketSourceIdentity {
    Derp {
        node_id: String,
    },
    Direct {
        node_id: String,
        src_wire_id: [u8; 20],
    },
}

impl PacketSourceIdentity {
    pub fn node_id(&self) -> &str {
        match self {
            Self::Derp { node_id } | Self::Direct { node_id, .. } => node_id,
        }
    }
}

impl Transport {
    pub async fn new(
        conn: ConnManager,
        derp: Option<DerpClient>,
        my_node_id: String,
        my_x25519_priv: [u8; 32],
    ) -> Result<Self, String> {
        let udp = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("bind UDP: {}", e))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            derp: derp.map(Arc::new),
            my_node_id,
            my_x25519_priv,
            udp: Some(Arc::new(udp)),
        })
    }

    #[cfg(test)]
    pub fn new_for_tests(
        conn: ConnManager,
        derp: Option<DerpClient>,
        my_node_id: String,
        my_x25519_priv: [u8; 32],
    ) -> Self {
        Self {
            conn: Arc::new(Mutex::new(conn)),
            derp: derp.map(Arc::new),
            my_node_id,
            my_x25519_priv,
            udp: None,
        }
    }

    fn my_wire_id(&self) -> [u8; 20] {
        crypto::node_id_wire_id(&self.my_node_id)
    }

    /// Cache a peer identity that was resolved from coordination.
    pub async fn remember_peer_identity(&self, peer_id: &str, expected_x25519_pub: [u8; 32]) {
        let mut conn = self.conn.lock().await;
        conn.remember_peer_identity(peer_id, expected_x25519_pub);
    }

    /// Forget a peer's cached transport/session identity.
    pub async fn forget_peer_identity(&self, peer_id: &str) {
        let mut conn = self.conn.lock().await;
        conn.forget_peer_identity(peer_id);
    }

    /// Retain only the listed peer identities in the transport cache.
    pub async fn retain_peer_identities(
        &self,
        retain: &std::collections::HashSet<String>,
    ) -> usize {
        let mut conn = self.conn.lock().await;
        conn.retain_peer_identities(retain)
    }

    async fn note_inbound_activity(&self, peer_id: &str) {
        let mut conn = self.conn.lock().await;
        conn.note_inbound(peer_id);
    }

    async fn note_outbound_activity(&self, peer_id: &str) {
        let mut conn = self.conn.lock().await;
        conn.note_outbound(peer_id);
    }

    /// Send raw bytes over the best available path (no encryption).
    async fn send_raw(&self, peer_id: &str, packet: &[u8]) -> Result<(), String> {
        if let Some(client) = self.derp.as_ref() {
            return client.send(peer_id, packet).await;
        }

        let mut conn = self.conn.lock().await;
        let path = conn.connect(peer_id).await?;

        match path {
            ConnPath::Lan(addr) | ConnPath::Direct(addr) => {
                if let Some(ref udp) = self.udp {
                    udp.send_to(packet, addr)
                        .await
                        .map_err(|e| format!("UDP send: {}", e))?;
                }
            }
            ConnPath::Derp => {
                drop(conn);
                if let Some(client) = self.derp.as_ref() {
                    client.send(peer_id, packet).await?;
                } else {
                    return Err("DERP not connected".to_string());
                }
            }
        }
        Ok(())
    }

    /// Perform Noise IK handshake with a peer.
    /// After this completes, the peer has an established NoiseSession.
    pub async fn handshake(
        &self,
        peer_id: &str,
        their_x25519_pub: &[u8; 32],
    ) -> Result<(), String> {
        {
            let mut conn = self.conn.lock().await;
            conn.remember_peer_identity(peer_id, *their_x25519_pub);
        }

        let (handshake, m1) =
            noise::begin_handshake_initiator(&self.my_x25519_priv, their_x25519_pub)?;

        let src = self.my_wire_id();
        let dst = crypto::node_id_wire_id(peer_id);
        let packet = crypto::encode_wire_packet_v2(crypto::PACKET_HANDSHAKE, &src, &dst, &m1);
        self.send_raw(peer_id, &packet).await?;
        self.note_outbound_activity(peer_id).await;

        {
            let mut conn = self.conn.lock().await;
            let pc = conn.get_or_create(peer_id);
            pc.session = SessionState::HandshakePending(handshake);
        }

        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let conn = self.conn.lock().await;
            if let Some(pc) = conn.peers.get(peer_id) {
                if matches!(pc.session, SessionState::Established(_)) {
                    return Ok(());
                }
            }
        }

        Err("handshake timeout waiting for M2".to_string())
    }

    /// Encrypt plaintext and send to peer via Noise transport.
    pub async fn send(&self, peer_id: &str, plaintext: &[u8]) -> Result<(), String> {
        let ciphertext = {
            let mut conn = self.conn.lock().await;
            let pc = conn.get_or_create(peer_id);
            match &mut pc.session {
                SessionState::Established(session) => noise::encrypt(session, plaintext)?,
                _ => {
                    return Err("no session key established".to_string());
                }
            }
        };

        let src = self.my_wire_id();
        let dst = crypto::node_id_wire_id(peer_id);
        let packet =
            crypto::encode_wire_packet_v2(crypto::PACKET_TRANSPORT, &src, &dst, &ciphertext);
        self.send_raw(peer_id, &packet).await?;
        self.note_outbound_activity(peer_id).await;
        Ok(())
    }

    async fn fetch_expected_peer_key_from_coord(&self, peer_id: &str) -> Option<[u8; 32]> {
        let coord = {
            let conn = self.conn.lock().await;
            conn.coord.clone()
        }?;
        let keys = coord.get_peer_keys(peer_id).await.ok()?;
        let decoded = hex::decode(&keys.x25519_pub).ok()?;
        if decoded.len() != 32 {
            return None;
        }
        let mut x_pub = [0u8; 32];
        x_pub.copy_from_slice(&decoded);
        self.remember_peer_identity(peer_id, x_pub).await;
        Some(x_pub)
    }

    /// Handle an inbound handshake message (M1 from initiator or M2 from responder).
    async fn handle_handshake(
        &self,
        from_source: &PacketSourceIdentity,
        payload: &[u8],
    ) -> Result<(), String> {
        let from_peer = from_source.node_id();
        let mut expected_remote_key = {
            let conn = self.conn.lock().await;
            conn.expected_peer_key(from_peer)
        };
        if expected_remote_key.is_none() {
            expected_remote_key = self.fetch_expected_peer_key_from_coord(from_peer).await;
        }
        let mut conn = self.conn.lock().await;
        let pc = conn.get_or_create(from_peer);

        match &mut pc.session {
            SessionState::HandshakePending(handshake) => {
                let (_response, _) = noise::process_handshake_message(handshake, payload)?;
                verify_remote_static_binding(from_peer, expected_remote_key, handshake)?;
                let old_session = std::mem::replace(&mut pc.session, SessionState::None);
                if let SessionState::HandshakePending(hs) = old_session {
                    let session = noise::into_transport(hs)?;
                    pc.session = SessionState::Established(session);
                }
            }
            _ => {
                let mut handshake = noise::begin_handshake_responder(&self.my_x25519_priv)?;
                let (m2_opt, _) = noise::process_handshake_message(&mut handshake, payload)?;
                verify_remote_static_binding(from_peer, expected_remote_key, &handshake)?;

                if let Some(m2) = m2_opt {
                    let src = self.my_wire_id();
                    let dst = crypto::node_id_wire_id(from_peer);
                    let packet =
                        crypto::encode_wire_packet_v2(crypto::PACKET_HANDSHAKE, &src, &dst, &m2);
                    drop(conn);
                    self.send_raw(from_peer, &packet).await?;
                    self.note_outbound_activity(from_peer).await;

                    let session = noise::into_transport(handshake)?;
                    let mut conn = self.conn.lock().await;
                    let pc = conn.get_or_create(from_peer);
                    pc.session = SessionState::Established(session);
                } else {
                    return Err("IK responder did not produce M2".to_string());
                }
            }
        }
        Ok(())
    }

    /// Receive and decrypt the next inbound message. Returns (verified source, plaintext).
    /// Handshake messages are handled internally and not returned to the caller.
    pub async fn recv(&self) -> Result<(PacketSourceIdentity, Vec<u8>), String> {
        loop {
            let (raw_source, raw) = self.recv_raw().await?;
            if raw.is_empty() {
                continue;
            }

            match raw[0] {
                0x02 => {
                    let (_, pkt_type, src, dst, payload) = crypto::decode_wire_packet_v2(&raw)?;
                    if dst != self.my_wire_id() {
                        eprintln!(
                            "dropping V2 packet for different destination {}",
                            hex::encode(dst)
                        );
                        continue;
                    }
                    let source = match self.resolve_packet_source(raw_source, src).await {
                        Ok(source) => source,
                        Err(err) => {
                            eprintln!("discarding V2 packet: {}", err);
                            continue;
                        }
                    };
                    let peer_id = source.node_id().to_string();
                    self.note_inbound_activity(&peer_id).await;

                    match pkt_type {
                        crypto::PACKET_HANDSHAKE => {
                            if let Err(err) = self.handle_handshake(&source, payload).await {
                                eprintln!("handshake error from {}: {}", peer_id, err);
                            }
                            continue;
                        }
                        crypto::PACKET_TRANSPORT => {
                            let mut conn = self.conn.lock().await;
                            let pc = conn.get_or_create(&peer_id);
                            match &mut pc.session {
                                SessionState::Established(session) => {
                                    let pt = noise::decrypt(session, payload)?;
                                    return Ok((source, pt));
                                }
                                _ => {
                                    if let Some(prev) = pc.previous_session.as_mut() {
                                        if let Ok(pt) = noise::decrypt(prev, payload) {
                                            return Ok((source, pt));
                                        }
                                    }
                                    eprintln!("no session for V2 transport from {}", peer_id);
                                    continue;
                                }
                            }
                        }
                        _ => {
                            eprintln!("unknown V2 packet type: {}", pkt_type);
                            continue;
                        }
                    }
                }
                0x01 => {
                    let (_ver, src, dst, nonce, _ct) = crypto::decode_wire_packet(&raw)?;
                    if dst != self.my_wire_id() {
                        eprintln!(
                            "dropping legacy V1 packet for different destination {}",
                            hex::encode(dst)
                        );
                        continue;
                    }
                    let source = match self.resolve_packet_source(raw_source, src).await {
                        Ok(source) => source,
                        Err(err) => {
                            eprintln!("discarding V1 packet: {}", err);
                            continue;
                        }
                    };
                    eprintln!(
                        "received legacy V1 packet from {} (nonce {}), dropping — upgrade peer",
                        source.node_id(),
                        nonce
                    );
                    continue;
                }
                version => {
                    eprintln!("unknown packet version: {}", version);
                    continue;
                }
            }
        }
    }

    async fn resolve_packet_source(
        &self,
        raw_source: RawPacketSource,
        src_wire_id: [u8; 20],
    ) -> Result<PacketSourceIdentity, String> {
        match raw_source {
            RawPacketSource::Derp(node_id) => {
                let expected_wire_id = crypto::node_id_wire_id(&node_id);
                if expected_wire_id != src_wire_id {
                    return Err(format!(
                        "DERP source {} did not match packet header {}",
                        node_id,
                        hex::encode(src_wire_id)
                    ));
                }
                Ok(PacketSourceIdentity::Derp { node_id })
            }
            RawPacketSource::Udp => {
                let conn = self.conn.lock().await;
                let node_id = conn.resolve_peer_id(&src_wire_id).ok_or_else(|| {
                    format!(
                        "unresolved direct packet source {}; no cached node identity",
                        hex::encode(src_wire_id)
                    )
                })?;
                Ok(PacketSourceIdentity::Direct {
                    node_id,
                    src_wire_id,
                })
            }
        }
    }

    /// Receive raw bytes from any path (DERP or UDP).
    async fn recv_raw(&self) -> Result<(RawPacketSource, Vec<u8>), String> {
        if let Some(client) = self.derp.as_ref() {
            if let Ok((src_id, data)) = client.recv().await {
                return Ok((RawPacketSource::Derp(src_id), data));
            }
        }

        if let Some(ref udp) = self.udp {
            let mut buf = vec![0u8; 65536];
            let (len, _addr) = udp
                .recv_from(&mut buf)
                .await
                .map_err(|e| format!("UDP recv: {}", e))?;
            buf.truncate(len);
            Ok((RawPacketSource::Udp, buf))
        } else {
            Err("no receive path available".to_string())
        }
    }
}

fn verify_remote_static_binding(
    peer_id: &str,
    expected_remote_key: Option<[u8; 32]>,
    handshake: &noise::NoiseHandshake,
) -> Result<(), String> {
    let expected_remote_key = expected_remote_key.ok_or_else(|| {
        format!(
            "cannot verify handshake identity for {}; no cached coordination key",
            peer_id
        )
    })?;
    let remote_key = noise::remote_static_key(handshake)?;
    if remote_key != expected_remote_key {
        return Err(format!(
            "handshake key mismatch for {}: expected {}, got {}",
            peer_id,
            hex::encode(expected_remote_key),
            hex::encode(remote_key)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    use super::*;

    fn test_transport(my_node_id: &str) -> Transport {
        let signing = SigningKey::generate(&mut OsRng);
        let x_priv = crypto::ed25519_to_x25519_private(&signing.to_bytes());
        Transport::new_for_tests(ConnManager::new(None), None, my_node_id.to_string(), x_priv)
    }

    #[tokio::test]
    async fn udp_source_requires_cached_node_identity() {
        let transport = test_transport("kd_self");
        let err = transport
            .resolve_packet_source(RawPacketSource::Udp, crypto::node_id_wire_id("kd_peer"))
            .await
            .unwrap_err();
        assert!(err.contains("unresolved direct packet source"));
    }

    #[tokio::test]
    async fn udp_source_resolves_to_real_node_id_when_cached() {
        let transport = test_transport("kd_self");
        transport.remember_peer_identity("kd_peer", [7u8; 32]).await;

        let source = transport
            .resolve_packet_source(RawPacketSource::Udp, crypto::node_id_wire_id("kd_peer"))
            .await
            .unwrap();

        assert_eq!(source.node_id(), "kd_peer");
        assert!(matches!(source, PacketSourceIdentity::Direct { .. }));
    }

    #[tokio::test]
    async fn derp_source_must_match_wire_header_identity() {
        let transport = test_transport("kd_self");
        let err = transport
            .resolve_packet_source(
                RawPacketSource::Derp("kd_peer_a".to_string()),
                crypto::node_id_wire_id("kd_peer_b"),
            )
            .await
            .unwrap_err();
        assert!(err.contains("did not match packet header"));
    }

    #[tokio::test]
    async fn forget_peer_identity_removes_cached_wire_mapping() {
        let transport = test_transport("kd_self");
        transport.remember_peer_identity("kd_peer", [7u8; 32]).await;
        transport.forget_peer_identity("kd_peer").await;

        let err = transport
            .resolve_packet_source(RawPacketSource::Udp, crypto::node_id_wire_id("kd_peer"))
            .await
            .unwrap_err();
        assert!(err.contains("unresolved direct packet source"));
    }

    #[tokio::test]
    async fn responder_handshake_rejects_mismatched_cached_coordination_key() {
        let responder_signing = SigningKey::generate(&mut OsRng);
        let responder_x_priv = crypto::ed25519_to_x25519_private(&responder_signing.to_bytes());
        let responder_x_pub =
            crypto::ed25519_to_x25519_public(responder_signing.verifying_key().as_bytes()).unwrap();

        let initiator_signing = SigningKey::generate(&mut OsRng);
        let initiator_x_priv = crypto::ed25519_to_x25519_private(&initiator_signing.to_bytes());
        let (_handshake, m1) =
            noise::begin_handshake_initiator(&initiator_x_priv, &responder_x_pub).unwrap();

        let transport = Transport::new_for_tests(
            ConnManager::new(None),
            None,
            "kd_responder".to_string(),
            responder_x_priv,
        );
        transport
            .remember_peer_identity("kd_initiator", [9u8; 32])
            .await;

        let source = PacketSourceIdentity::Direct {
            node_id: "kd_initiator".to_string(),
            src_wire_id: crypto::node_id_wire_id("kd_initiator"),
        };
        let err = transport.handle_handshake(&source, &m1).await.unwrap_err();

        assert!(err.contains("handshake key mismatch"));
    }
}
