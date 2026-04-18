use std::net::SocketAddr;
use tokio::net::UdpSocket;

const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_MAGIC_COOKIE: u32 = 0x2112A442;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Build a 20-byte STUN binding request header.
fn build_binding_request(txn_id: &[u8; 12]) -> [u8; 20] {
    let mut buf = [0u8; 20];
    // Message type: Binding Request (0x0001)
    buf[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    // Message length: 0 (no attributes)
    buf[2..4].copy_from_slice(&0u16.to_be_bytes());
    // Magic cookie
    buf[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    // Transaction ID (12 bytes)
    buf[8..20].copy_from_slice(txn_id);
    buf
}

/// Parse XOR-MAPPED-ADDRESS from a STUN response.
fn parse_xor_mapped_address(resp: &[u8]) -> Result<SocketAddr, String> {
    if resp.len() < 20 {
        return Err("response too short".to_string());
    }

    let msg_len = u16::from_be_bytes([resp[2], resp[3]]) as usize;
    if resp.len() < 20 + msg_len {
        return Err("truncated response".to_string());
    }

    let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
    let mut offset = 20;
    let end = 20 + msg_len;

    while offset + 4 <= end {
        let attr_type = u16::from_be_bytes([resp[offset], resp[offset + 1]]);
        let attr_len = u16::from_be_bytes([resp[offset + 2], resp[offset + 3]]) as usize;
        let attr_start = offset + 4;

        if attr_type == ATTR_XOR_MAPPED_ADDRESS && attr_len >= 8 {
            let family = resp[attr_start + 1];
            if family == 0x01 {
                // IPv4
                let xor_port = u16::from_be_bytes([resp[attr_start + 2], resp[attr_start + 3]]);
                let port = xor_port ^ (STUN_MAGIC_COOKIE >> 16) as u16;

                let mut ip_bytes = [0u8; 4];
                ip_bytes.copy_from_slice(&resp[attr_start + 4..attr_start + 8]);
                for i in 0..4 {
                    ip_bytes[i] ^= cookie_bytes[i];
                }

                let ip =
                    std::net::Ipv4Addr::new(ip_bytes[0], ip_bytes[1], ip_bytes[2], ip_bytes[3]);
                return Ok(SocketAddr::new(ip.into(), port));
            }
        }

        // Attributes are padded to 4-byte boundaries
        let padded = (attr_len + 3) & !3;
        offset = attr_start + padded;
    }

    Err("XOR-MAPPED-ADDRESS not found".to_string())
}

/// Send STUN binding request and return the reflexive (public) address.
pub async fn get_reflexive_addr(stun_server: &str) -> Result<SocketAddr, String> {
    let sock = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind: {}", e))?;

    let server_addr: SocketAddr = stun_server
        .parse()
        .map_err(|e| format!("parse STUN server addr: {}", e))?;

    let mut txn_id = [0u8; 12];
    for (i, b) in txn_id.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(37).wrapping_add(7);
    }

    let request = build_binding_request(&txn_id);
    sock.send_to(&request, server_addr)
        .await
        .map_err(|e| format!("send: {}", e))?;

    let mut buf = [0u8; 512];
    let deadline =
        tokio::time::timeout(std::time::Duration::from_secs(3), sock.recv_from(&mut buf));

    let (len, _) = deadline
        .await
        .map_err(|_| "STUN timeout".to_string())?
        .map_err(|e| format!("recv: {}", e))?;

    // Verify transaction ID matches
    if buf[8..20] != txn_id {
        return Err("transaction ID mismatch".to_string());
    }

    parse_xor_mapped_address(&buf[..len])
}
