//! Noise IK handshake and transport session — WireGuard-like security.
//!
//! Uses the `snow` crate with pattern `Noise_IK_25519_ChaChaPoly_BLAKE2s`.
//! IK means the initiator knows the responder's static key in advance
//! (from the coordination server), so the handshake is 1-RTT (2 messages).

use snow::{Builder, HandshakeState, TransportState};
use std::time::Instant;

const NOISE_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/// Maximum payload size for snow operations.
const MAX_MSG_LEN: usize = 65535;

/// Rekey after this many messages per session.
const REKEY_MESSAGE_LIMIT: u64 = 1u64 << 60;

/// Rekey after this many seconds.
const REKEY_TIME_SECS: u64 = 120;

/// In-progress Noise IK handshake.
pub struct NoiseHandshake {
    pub state: HandshakeState,
}

/// Established Noise transport session with rekey tracking.
pub struct NoiseSession {
    pub transport: TransportState,
    pub created_at: Instant,
    pub message_count: u64,
}

/// Begin a handshake as initiator. Returns the handshake state and M1 bytes.
///
/// The initiator knows the responder's static public key in advance.
pub fn begin_handshake_initiator(
    my_x25519_priv: &[u8; 32],
    their_x25519_pub: &[u8; 32],
) -> Result<(NoiseHandshake, Vec<u8>), String> {
    let builder = Builder::new(NOISE_PATTERN.parse().unwrap())
        .local_private_key(my_x25519_priv)
        .remote_public_key(their_x25519_pub);

    let mut state = builder
        .build_initiator()
        .map_err(|e| format!("noise init: {}", e))?;

    let mut buf = vec![0u8; MAX_MSG_LEN];
    let len = state
        .write_message(&[], &mut buf)
        .map_err(|e| format!("noise M1: {}", e))?;
    buf.truncate(len);

    Ok((NoiseHandshake { state }, buf))
}

/// Begin a handshake as responder. Call `process_handshake_message` with M1 next.
pub fn begin_handshake_responder(my_x25519_priv: &[u8; 32]) -> Result<NoiseHandshake, String> {
    let builder = Builder::new(NOISE_PATTERN.parse().unwrap()).local_private_key(my_x25519_priv);

    let state = builder
        .build_responder()
        .map_err(|e| format!("noise resp: {}", e))?;

    Ok(NoiseHandshake { state })
}

/// Process an incoming handshake message.
///
/// Returns:
/// - `(Some(response_bytes), None)` — need to send response, handshake not done
/// - `(None, Some(session))` — handshake complete, no response needed (initiator receiving M2)
/// - `(Some(response_bytes), Some(session))` — handshake complete, send response (responder receiving M1)
pub fn process_handshake_message(
    handshake: &mut NoiseHandshake,
    msg: &[u8],
) -> Result<(Option<Vec<u8>>, Option<NoiseSession>), String> {
    let mut read_buf = vec![0u8; MAX_MSG_LEN];
    let _len = handshake
        .state
        .read_message(msg, &mut read_buf)
        .map_err(|e| format!("noise read: {}", e))?;

    if handshake.state.is_handshake_finished() {
        // Handshake done after reading (initiator received M2)
        return Ok((None, None)); // caller should call into_transport
    }

    // Write response
    let mut write_buf = vec![0u8; MAX_MSG_LEN];
    let len = handshake
        .state
        .write_message(&[], &mut write_buf)
        .map_err(|e| format!("noise write: {}", e))?;
    write_buf.truncate(len);

    if handshake.state.is_handshake_finished() {
        // Handshake done after writing (responder sent M2)
        Ok((Some(write_buf), None)) // caller should call into_transport
    } else {
        Ok((Some(write_buf), None))
    }
}

/// Get the remote peer's static X25519 key as an exact 32-byte array.
pub fn remote_static_key(handshake: &NoiseHandshake) -> Result<[u8; 32], String> {
    let remote = handshake
        .state
        .get_remote_static()
        .ok_or_else(|| "handshake did not expose remote static key".to_string())?;
    if remote.len() != 32 {
        return Err(format!(
            "handshake remote static key has invalid length {}",
            remote.len()
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(remote);
    Ok(out)
}

/// Finalize a completed handshake into a transport session.
pub fn into_transport(handshake: NoiseHandshake) -> Result<NoiseSession, String> {
    let transport = handshake
        .state
        .into_transport_mode()
        .map_err(|e| format!("noise transport: {}", e))?;

    Ok(NoiseSession {
        transport,
        created_at: Instant::now(),
        message_count: 0,
    })
}

/// Encrypt a message using the established Noise transport session.
pub fn encrypt(session: &mut NoiseSession, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; plaintext.len() + 16]; // AEAD tag overhead
    let len = session
        .transport
        .write_message(plaintext, &mut buf)
        .map_err(|e| format!("noise encrypt: {}", e))?;
    buf.truncate(len);
    session.message_count += 1;
    Ok(buf)
}

/// Decrypt a message using the established Noise transport session.
///
/// Snow's TransportState handles nonce validation internally — it rejects
/// messages with out-of-order or replayed nonces via its internal counter.
/// We also track message_count for rekey decisions.
pub fn decrypt(session: &mut NoiseSession, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; ciphertext.len()];
    let len = session
        .transport
        .read_message(ciphertext, &mut buf)
        .map_err(|e| format!("noise decrypt: {}", e))?;
    buf.truncate(len);
    session.message_count += 1;
    Ok(buf)
}

/// Check if the session needs rekeying.
pub fn needs_rekey(session: &NoiseSession) -> bool {
    session.message_count >= REKEY_MESSAGE_LIMIT
        || session.created_at.elapsed().as_secs() >= REKEY_TIME_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate a random X25519 keypair for testing.
    fn gen_keypair() -> ([u8; 32], [u8; 32]) {
        use rand::RngCore;
        let mut rng = rand::thread_rng();
        let mut priv_key = [0u8; 32];
        rng.fill_bytes(&mut priv_key);
        let secret = x25519_dalek::StaticSecret::from(priv_key);
        let public = x25519_dalek::PublicKey::from(&secret);
        (priv_key, *public.as_bytes())
    }

    #[test]
    fn handshake_roundtrip() {
        let (init_priv, _init_pub) = gen_keypair();
        let (resp_priv, resp_pub) = gen_keypair();

        // Initiator creates M1
        let (mut init_hs, m1) = begin_handshake_initiator(&init_priv, &resp_pub).unwrap();

        // Responder processes M1, produces M2
        let mut resp_hs = begin_handshake_responder(&resp_priv).unwrap();
        let (m2_opt, _) = process_handshake_message(&mut resp_hs, &m1).unwrap();
        let m2 = m2_opt.expect("responder should produce M2");

        // Initiator processes M2
        let (resp_bytes, _) = process_handshake_message(&mut init_hs, &m2).unwrap();
        assert!(
            resp_bytes.is_none(),
            "initiator should not produce M3 in IK"
        );

        // Both transition to transport mode
        let mut init_session = into_transport(init_hs).unwrap();
        let mut resp_session = into_transport(resp_hs).unwrap();

        // Initiator sends to responder
        let ct = encrypt(&mut init_session, b"hello from initiator").unwrap();
        let pt = decrypt(&mut resp_session, &ct).unwrap();
        assert_eq!(pt, b"hello from initiator");

        // Responder sends to initiator
        let ct2 = encrypt(&mut resp_session, b"hello from responder").unwrap();
        let pt2 = decrypt(&mut init_session, &ct2).unwrap();
        assert_eq!(pt2, b"hello from responder");
    }

    #[test]
    fn encrypt_decrypt_bidirectional() {
        let (init_priv, _) = gen_keypair();
        let (resp_priv, resp_pub) = gen_keypair();

        let (mut init_hs, m1) = begin_handshake_initiator(&init_priv, &resp_pub).unwrap();
        let mut resp_hs = begin_handshake_responder(&resp_priv).unwrap();
        let (m2, _) = process_handshake_message(&mut resp_hs, &m1).unwrap();
        process_handshake_message(&mut init_hs, &m2.unwrap()).unwrap();

        let mut init_s = into_transport(init_hs).unwrap();
        let mut resp_s = into_transport(resp_hs).unwrap();

        // Send 100 messages in both directions
        for i in 0..100 {
            let msg = format!("message {}", i);
            let ct = encrypt(&mut init_s, msg.as_bytes()).unwrap();
            let pt = decrypt(&mut resp_s, &ct).unwrap();
            assert_eq!(pt, msg.as_bytes());

            let ct2 = encrypt(&mut resp_s, msg.as_bytes()).unwrap();
            let pt2 = decrypt(&mut init_s, &ct2).unwrap();
            assert_eq!(pt2, msg.as_bytes());
        }
    }

    #[test]
    fn rekey_triggers_on_message_count() {
        let (init_priv, _) = gen_keypair();
        let (resp_priv, resp_pub) = gen_keypair();

        let (mut init_hs, m1) = begin_handshake_initiator(&init_priv, &resp_pub).unwrap();
        let mut resp_hs = begin_handshake_responder(&resp_priv).unwrap();
        let (m2, _) = process_handshake_message(&mut resp_hs, &m1).unwrap();
        process_handshake_message(&mut init_hs, &m2.unwrap()).unwrap();

        let mut session = into_transport(init_hs).unwrap();
        assert!(!needs_rekey(&session));

        // Simulate high message count
        session.message_count = REKEY_MESSAGE_LIMIT;
        assert!(needs_rekey(&session));
    }
}
