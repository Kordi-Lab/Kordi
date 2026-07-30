use super::peer_identities::seed_transport_identities_from_projects;
use super::*;
use crate::coord_client::PeerKeys;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

fn test_transport(node_id: &str) -> Transport {
    let signing = SigningKey::generate(&mut OsRng);
    let x_priv = crate::crypto::ed25519_to_x25519_private(&signing.to_bytes());
    Transport::new_for_tests(ConnManager::new(None), None, node_id.to_string(), x_priv)
}

#[tokio::test]
async fn sync_transport_identities_prunes_stale_peers() {
    let transport = test_transport("kd_self");
    transport
        .remember_peer_identity("kd_peer_old", [7u8; 32])
        .await;
    transport
        .remember_peer_identity("kd_peer_new", [8u8; 32])
        .await;

    let retain = std::collections::HashSet::from(["kd_peer_new".to_string()]);
    let pruned = transport.retain_peer_identities(&retain).await;

    assert_eq!(pruned, 1);
    let conn = transport.conn.lock().await;
    assert!(conn.expected_peer_key("kd_peer_old").is_none());
    assert_eq!(conn.expected_peer_key("kd_peer_new"), Some([8u8; 32]));
}

#[tokio::test]
async fn seed_transport_identities_from_projects_primes_first_contact_cache() {
    let transport = test_transport("kd_self");
    let peer_signing = SigningKey::generate(&mut OsRng);
    let peer_x25519 =
        crate::crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes()).unwrap();
    let project_ids = vec!["proj_1".to_string()];

    let seeded = seed_transport_identities_from_projects(
        &transport,
        "kd_self",
        &project_ids,
        |_project_id| async {
            Ok(vec![PeerKeys {
                node_id: "kd_peer".to_string(),
                ed25519_pub: "unused".to_string(),
                x25519_pub: hex::encode(peer_x25519),
            }])
        },
    )
    .await;

    assert_eq!(seeded, 1);
    let conn = transport.conn.lock().await;
    assert_eq!(
        conn.resolve_peer_id(&crate::crypto::node_id_wire_id("kd_peer")),
        Some("kd_peer".to_string())
    );
    assert_eq!(conn.expected_peer_key("kd_peer"), Some(peer_x25519));
}
