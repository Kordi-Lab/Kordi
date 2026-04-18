use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

const MDNS_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const SERVICE_NAME: &str = "_bridges._udp.local";

/// Announce this node on mDNS (sends a single mDNS response packet).
pub fn announce(node_id: &str, port: u16) {
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("mDNS announce bind failed: {}", e);
            return;
        }
    };

    // Build a minimal mDNS announcement: TXT record with node_id and port
    let txt = format!("id={},port={}", node_id, port);
    let packet = build_mdns_response(SERVICE_NAME, &txt);

    let dest = SocketAddr::new(MDNS_ADDR.into(), MDNS_PORT);
    if let Err(e) = sock.send_to(&packet, dest) {
        eprintln!("mDNS announce send failed: {}", e);
    }
}

/// Discover LAN peers via mDNS. Listens for a short window and returns found peers.
pub async fn discover() -> Vec<(String, SocketAddr)> {
    let result = tokio::task::spawn_blocking(discover_blocking).await;
    result.unwrap_or_default()
}

fn discover_blocking() -> Vec<(String, SocketAddr)> {
    let sock = match UdpSocket::bind(format!("0.0.0.0:{}", MDNS_PORT)) {
        Ok(s) => s,
        Err(_) => {
            // Port in use, try ephemeral
            match UdpSocket::bind("0.0.0.0:0") {
                Ok(s) => s,
                Err(_) => return vec![],
            }
        }
    };

    sock.set_read_timeout(Some(Duration::from_millis(500))).ok();
    sock.join_multicast_v4(&MDNS_ADDR, &Ipv4Addr::UNSPECIFIED)
        .ok();

    // Send a query for _bridges._udp.local
    let query = build_mdns_query(SERVICE_NAME);
    let dest = SocketAddr::new(MDNS_ADDR.into(), MDNS_PORT);
    sock.send_to(&query, dest).ok();

    let mut found: HashMap<String, SocketAddr> = HashMap::new();
    let mut buf = [0u8; 4096];

    // Listen for responses for up to 500ms
    while let Ok((len, src_addr)) = sock.recv_from(&mut buf) {
        if let Some((node_id, port)) = parse_bridges_txt(&buf[..len]) {
            let peer_addr = SocketAddr::new(src_addr.ip(), port);
            found.insert(node_id, peer_addr);
        }
    }

    found.into_iter().collect()
}

/// Build a minimal mDNS query packet for a service name.
fn build_mdns_query(name: &str) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    // Header: ID=0, flags=0, QDCOUNT=1
    pkt.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    // Encode DNS name
    encode_dns_name(&mut pkt, name);
    // QTYPE=TXT(16), QCLASS=IN(1)
    pkt.extend_from_slice(&[0, 16, 0, 1]);
    pkt
}

/// Build a minimal mDNS response with a TXT record.
fn build_mdns_response(name: &str, txt: &str) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(128);
    // Header: ID=0, flags=0x8400 (response, authoritative), ANCOUNT=1
    pkt.extend_from_slice(&[0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    encode_dns_name(&mut pkt, name);
    // TYPE=TXT(16), CLASS=IN(1)|flush(0x8001), TTL=120, RDLENGTH
    pkt.extend_from_slice(&[0, 16, 0x80, 1]);
    pkt.extend_from_slice(&120u32.to_be_bytes());
    let txt_bytes = txt.as_bytes();
    let rdlen = (txt_bytes.len() + 1) as u16;
    pkt.extend_from_slice(&rdlen.to_be_bytes());
    pkt.push(txt_bytes.len() as u8);
    pkt.extend_from_slice(txt_bytes);
    pkt
}

fn encode_dns_name(pkt: &mut Vec<u8>, name: &str) {
    for label in name.split('.') {
        pkt.push(label.len() as u8);
        pkt.extend_from_slice(label.as_bytes());
    }
    pkt.push(0); // root terminator
}

/// Parse a bridges TXT record from an mDNS packet. Returns (node_id, port).
fn parse_bridges_txt(data: &[u8]) -> Option<(String, u16)> {
    let s = String::from_utf8_lossy(data);
    // Simple: scan for "id=" and "port=" in the packet payload
    let id_start = s.find("id=")?;
    let after_id = &s[id_start + 3..];
    let id_end = after_id.find(',')?;
    let node_id = after_id[..id_end].to_string();

    let port_start = s.find("port=")?;
    let after_port = &s[port_start + 5..];
    // Port ends at non-digit
    let port_str: String = after_port
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let port: u16 = port_str.parse().ok()?;

    Some((node_id, port))
}
