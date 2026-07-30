use std::collections::HashSet;
use std::future::Future;

use super::*;

pub(super) async fn seed_transport_identities_from_projects<F, Fut>(
    transport: &Transport,
    my_node_id: &str,
    project_ids: &[String],
    mut fetch_keys: F,
) -> usize
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<Vec<PeerKeys>, String>>,
{
    let mut seeded = HashSet::new();
    for project_id in project_ids {
        let keys = match fetch_keys(project_id).await {
            Ok(keys) => keys,
            Err(err) => {
                eprintln!(
                    "  identity prewarm failed for project {}: {}",
                    project_id, err
                );
                continue;
            }
        };

        for key in keys {
            if key.node_id == my_node_id || seeded.contains(&key.node_id) {
                continue;
            }
            let decoded = match hex::decode(&key.x25519_pub) {
                Ok(decoded) if decoded.len() == 32 => decoded,
                Ok(decoded) => {
                    eprintln!(
                        "  identity prewarm skipped {}: invalid x25519 key length {}",
                        key.node_id,
                        decoded.len()
                    );
                    continue;
                }
                Err(err) => {
                    eprintln!(
                        "  identity prewarm skipped {}: bad x25519 key: {}",
                        key.node_id, err
                    );
                    continue;
                }
            };
            let mut x_pub = [0u8; 32];
            x_pub.copy_from_slice(&decoded);
            transport.remember_peer_identity(&key.node_id, x_pub).await;
            seeded.insert(key.node_id);
        }
    }

    seeded.len()
}

fn load_local_project_ids() -> Result<Vec<String>, String> {
    let conn = crate::db::open_db().map_err(|err| format!("open local db: {}", err))?;
    crate::db::init_db(&conn).map_err(|err| format!("init local db: {}", err))?;
    Ok(crate::queries::list_projects(&conn)
        .into_iter()
        .map(|project| project.project_id)
        .collect())
}

pub(super) async fn sync_transport_identities_from_projects(
    transport: &Transport,
    coord: &CoordClient,
    my_node_id: &str,
) -> (usize, usize) {
    let project_ids = match load_local_project_ids() {
        Ok(project_ids) => project_ids,
        Err(err) => {
            eprintln!("  identity sync skipped: local db unavailable: {}", err);
            return (0, 0);
        }
    };

    if project_ids.is_empty() {
        let retain = std::collections::HashSet::new();
        let pruned = transport.retain_peer_identities(&retain).await;
        return (0, pruned);
    }

    let seeded = seed_transport_identities_from_projects(
        transport,
        my_node_id,
        &project_ids,
        |project_id| {
            let coord = coord.clone();
            let project_id = project_id.to_string();
            async move { coord.get_project_keys(&project_id).await }
        },
    )
    .await;

    let mut retain = HashSet::new();
    for project_id in &project_ids {
        match coord.get_project_keys(project_id).await {
            Ok(keys) => {
                for key in keys {
                    if key.node_id != my_node_id {
                        retain.insert(key.node_id);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "  identity prune skipped for project {}: {}",
                    project_id, err
                );
            }
        }
    }
    let pruned = transport.retain_peer_identities(&retain).await;
    (seeded, pruned)
}
