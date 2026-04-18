use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};

type WirePacketV1<'a> = (u8, [u8; 20], [u8; 20], u64, &'a [u8]);
type WirePacketV2<'a> = (u8, u8, [u8; 20], [u8; 20], &'a [u8]);

/// Derive the stable 20-byte wire identifier used inside transport packets.
pub fn node_id_wire_id(node_id: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    let hash = Sha256::digest(node_id.as_bytes());
    out.copy_from_slice(&hash[..20]);
    out
}

/// Convert Ed25519 private key to X25519 via SHA-512 clamping (RFC 7748).
pub fn ed25519_to_x25519_private(signing_key: &[u8; 32]) -> [u8; 32] {
    let hash = Sha512::digest(signing_key);
    let mut output = [0u8; 32];
    output.copy_from_slice(&hash[..32]);
    output[0] &= 248;
    output[31] &= 127;
    output[31] |= 64;
    output
}

/// Convert Ed25519 public key to X25519 via Montgomery form.
/// Returns Err on invalid keys instead of panicking.
pub fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    let ed_point = curve25519_dalek::edwards::CompressedEdwardsY(*ed_pub);
    let ed_point = ed_point
        .decompress()
        .ok_or_else(|| "invalid Ed25519 public key: decompression failed".to_string())?;
    Ok(ed_point.to_montgomery().to_bytes())
}

const MAILBOX_INFO_PREFIX: &[u8] = b"bridges-mailbox-v1";

#[derive(Debug, Serialize, Deserialize)]
struct MailboxEnvelope {
    version: u8,
    from: String,
    to: String,
    nonce: String,
    ciphertext: String,
}

fn derive_mailbox_key(
    my_x25519_priv: &[u8; 32],
    peer_x25519_pub: &[u8; 32],
    from_node_id: &str,
    to_node_id: &str,
) -> Result<[u8; 32], String> {
    let secret = x25519_dalek::StaticSecret::from(*my_x25519_priv);
    let peer = x25519_dalek::PublicKey::from(*peer_x25519_pub);
    let shared = secret.diffie_hellman(&peer);
    let hkdf = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let mut info =
        Vec::with_capacity(MAILBOX_INFO_PREFIX.len() + from_node_id.len() + to_node_id.len() + 2);
    info.extend_from_slice(MAILBOX_INFO_PREFIX);
    info.push(b':');
    info.extend_from_slice(from_node_id.as_bytes());
    info.push(b':');
    info.extend_from_slice(to_node_id.as_bytes());
    let mut key = [0u8; 32];
    hkdf.expand(&info, &mut key)
        .map_err(|e| format!("mailbox hkdf expand: {}", e))?;
    Ok(key)
}

pub fn encrypt_mailbox_payload(
    from_node_id: &str,
    to_node_id: &str,
    my_x25519_priv: &[u8; 32],
    peer_x25519_pub: &[u8; 32],
    plaintext: &[u8],
) -> Result<String, String> {
    let key = derive_mailbox_key(my_x25519_priv, peer_x25519_pub, from_node_id, to_node_id)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let nonce_bytes: [u8; 12] = rand::random();
    let aad = format!("{}|{}", from_node_id, to_node_id);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| format!("mailbox encrypt: {}", e))?;
    let envelope = MailboxEnvelope {
        version: 1,
        from: from_node_id.to_string(),
        to: to_node_id.to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(ciphertext),
    };
    serde_json::to_string(&envelope).map_err(|e| format!("serialize mailbox envelope: {}", e))
}

pub fn decrypt_mailbox_payload(
    my_node_id: &str,
    from_node_id: &str,
    my_x25519_priv: &[u8; 32],
    peer_x25519_pub: &[u8; 32],
    blob: &str,
) -> Result<Vec<u8>, String> {
    let envelope: MailboxEnvelope =
        serde_json::from_str(blob).map_err(|e| format!("parse mailbox envelope: {}", e))?;
    if envelope.version != 1 {
        return Err(format!(
            "unsupported mailbox envelope version {}",
            envelope.version
        ));
    }
    if envelope.from != from_node_id {
        return Err(format!(
            "mailbox envelope sender mismatch: expected {}, got {}",
            from_node_id, envelope.from
        ));
    }
    if envelope.to != my_node_id {
        return Err(format!(
            "mailbox envelope recipient mismatch: expected {}, got {}",
            my_node_id, envelope.to
        ));
    }
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(envelope.nonce)
        .map_err(|e| format!("decode mailbox nonce: {}", e))?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(envelope.ciphertext)
        .map_err(|e| format!("decode mailbox ciphertext: {}", e))?;
    if nonce.len() != 12 {
        return Err(format!("mailbox nonce has invalid length {}", nonce.len()));
    }
    let key = derive_mailbox_key(my_x25519_priv, peer_x25519_pub, from_node_id, my_node_id)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let aad = format!("{}|{}", from_node_id, my_node_id);
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| format!("mailbox decrypt: {}", e))
}

// ── V1 wire format (legacy, decode only for backward compat) ──

/// Parse V1 wire format. Returns (version, src_id, dst_id, nonce, ciphertext).
pub fn decode_wire_packet(data: &[u8]) -> Result<WirePacketV1<'_>, String> {
    const HEADER: usize = 1 + 20 + 20 + 8; // 49
    if data.len() < HEADER {
        return Err(format!("packet too short: {} < {}", data.len(), HEADER));
    }
    let version = data[0];
    let mut src = [0u8; 20];
    src.copy_from_slice(&data[1..21]);
    let mut dst = [0u8; 20];
    dst.copy_from_slice(&data[21..41]);
    let nonce = u64::from_be_bytes(data[41..49].try_into().unwrap());
    Ok((version, src, dst, nonce, &data[49..]))
}

// ── V2 wire format (Noise IK) ─────────────────────────────────

/// Packet types for V2 wire format.
pub const PACKET_HANDSHAKE: u8 = 0x01;
pub const PACKET_TRANSPORT: u8 = 0x02;

/// V2 wire format: [version:1=0x02][type:1][src_id:20][dst_id:20][payload:N]
pub fn encode_wire_packet_v2(
    packet_type: u8,
    src_id: &[u8; 20],
    dst_id: &[u8; 20],
    payload: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 1 + 20 + 20 + payload.len());
    buf.push(0x02); // version 2
    buf.push(packet_type);
    buf.extend_from_slice(src_id);
    buf.extend_from_slice(dst_id);
    buf.extend_from_slice(payload);
    buf
}

/// Parse V2 wire format. Returns (version, type, src_id, dst_id, payload).
pub fn decode_wire_packet_v2(data: &[u8]) -> Result<WirePacketV2<'_>, String> {
    const HEADER: usize = 1 + 1 + 20 + 20; // 42
    if data.len() < HEADER {
        return Err(format!("v2 packet too short: {} < {}", data.len(), HEADER));
    }
    let version = data[0];
    let packet_type = data[1];
    let mut src = [0u8; 20];
    src.copy_from_slice(&data[2..22]);
    let mut dst = [0u8; 20];
    dst.copy_from_slice(&data[22..42]);
    Ok((version, packet_type, src, dst, &data[42..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 64-entry sliding window for replay protection.
    struct ReplayWindow {
        highest: u64,
        bitmap: u64,
    }

    impl ReplayWindow {
        fn new() -> Self {
            Self {
                highest: 0,
                bitmap: 0,
            }
        }

        fn check_and_update(&mut self, nonce: u64) -> bool {
            if nonce == 0 && self.highest == 0 && self.bitmap == 0 {
                self.bitmap = 1;
                return true;
            }
            if nonce > self.highest {
                let shift = nonce - self.highest;
                if shift >= 64 {
                    self.bitmap = 0;
                } else {
                    self.bitmap <<= shift;
                }
                self.bitmap |= 1;
                self.highest = nonce;
                true
            } else {
                let diff = self.highest - nonce;
                if diff >= 64 {
                    false
                } else {
                    let bit = 1u64 << diff;
                    if self.bitmap & bit != 0 {
                        false
                    } else {
                        self.bitmap |= bit;
                        true
                    }
                }
            }
        }
    }

    #[test]
    fn v2_wire_packet_roundtrip() {
        let src = [3u8; 20];
        let dst = [4u8; 20];
        let payload = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let pkt = encode_wire_packet_v2(PACKET_TRANSPORT, &src, &dst, &payload);
        let (v, t, s, d, p) = decode_wire_packet_v2(&pkt).unwrap();
        assert_eq!((v, t), (0x02, PACKET_TRANSPORT));
        assert_eq!(s, src);
        assert_eq!(d, dst);
        assert_eq!(p, &payload[..]);
    }

    #[test]
    fn ed25519_to_x25519_invalid_key_returns_err() {
        let _ = ed25519_to_x25519_public(&[0u8; 32]);
        let _ = ed25519_to_x25519_public(&[0xFFu8; 32]);
        // No panic = success
    }

    #[test]
    fn replay_window_sequential() {
        let mut w = ReplayWindow::new();
        assert!(w.check_and_update(1));
        assert!(w.check_and_update(2));
        assert!(w.check_and_update(3));
        assert!(!w.check_and_update(1));
        assert!(!w.check_and_update(2));
        assert!(!w.check_and_update(3));
    }

    #[test]
    fn replay_window_out_of_order() {
        let mut w = ReplayWindow::new();
        assert!(w.check_and_update(5));
        assert!(w.check_and_update(3));
        assert!(w.check_and_update(4));
        assert!(!w.check_and_update(3));
    }

    #[test]
    fn replay_window_too_old() {
        let mut w = ReplayWindow::new();
        assert!(w.check_and_update(100));
        assert!(!w.check_and_update(30));
        assert!(w.check_and_update(50));
    }

    #[test]
    fn mailbox_payload_roundtrip() {
        let sender_signing = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let receiver_signing = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let sender_priv = ed25519_to_x25519_private(&sender_signing.to_bytes());
        let receiver_priv = ed25519_to_x25519_private(&receiver_signing.to_bytes());
        let sender_pub =
            ed25519_to_x25519_public(sender_signing.verifying_key().as_bytes()).unwrap();
        let receiver_pub =
            ed25519_to_x25519_public(receiver_signing.verifying_key().as_bytes()).unwrap();
        let blob = encrypt_mailbox_payload(
            "kd_sender",
            "kd_receiver",
            &sender_priv,
            &receiver_pub,
            b"hello mailbox",
        )
        .unwrap();
        let plaintext = decrypt_mailbox_payload(
            "kd_receiver",
            "kd_sender",
            &receiver_priv,
            &sender_pub,
            &blob,
        )
        .unwrap();
        assert_eq!(plaintext, b"hello mailbox");
    }
}
