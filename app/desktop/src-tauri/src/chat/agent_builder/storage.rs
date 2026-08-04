//! Durable draft metadata, path, JSON, and mutation-lock storage.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::super::now_millis;
use super::models::{
    DesktopAgentBuilderAssociation, DesktopAgentBuilderAssociationIndex,
    DesktopAgentBuilderMetadata, DesktopAgentBuilderTestReport,
};
use super::{METADATA_FILE, RESOURCES_DIR, SESSION_PREFIX, TEST_REPORT_FILE, WORKSPACE_DIR};

const ASSOCIATIONS_FILE: &str = "associations.json";

pub(super) fn drafts_root() -> PathBuf {
    kordi_core::config::preferred_global_settings_dir().join("agent-drafts")
}

pub(super) fn builder_mutation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(super) fn checked_draft_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    uuid::Uuid::parse_str(trimmed).map_err(|_| "Kordi Factory draft id is invalid".to_string())?;
    Ok(trimmed)
}

pub(super) fn container_for_draft(draft_id: &str) -> Result<PathBuf, String> {
    Ok(drafts_root().join(checked_draft_id(draft_id)?))
}

pub(super) fn workspace_for_draft(draft_id: &str) -> Result<PathBuf, String> {
    Ok(container_for_draft(draft_id)?.join(WORKSPACE_DIR))
}

pub(super) fn draft_container(workspace: &Path) -> Result<&Path, String> {
    workspace
        .parent()
        .ok_or_else(|| "Kordi Factory workspace is invalid".to_string())
}

pub(super) fn metadata_path(container: &Path) -> PathBuf {
    container.join(METADATA_FILE)
}

pub(super) fn test_report_path(container: &Path) -> PathBuf {
    container.join(TEST_REPORT_FILE)
}

pub(super) fn resources_root(container: &Path) -> PathBuf {
    container.join(RESOURCES_DIR).join("skills")
}

pub(super) fn write_metadata(
    workspace: &Path,
    metadata: &DesktopAgentBuilderMetadata,
) -> Result<(), String> {
    write_json(&metadata_path(draft_container(workspace)?), metadata)
}

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))
}

pub(super) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to encode {}: {error}", path.display()))?;
    fs::write(path, format!("{text}\n"))
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

pub(super) fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    }
    fs::write(path, content).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

fn associations_path(root: &Path) -> PathBuf {
    root.join(ASSOCIATIONS_FILE)
}

fn read_associations(root: &Path) -> Result<DesktopAgentBuilderAssociationIndex, String> {
    let path = associations_path(root);
    if !path.exists() {
        return Ok(DesktopAgentBuilderAssociationIndex::default());
    }
    let index = read_json::<DesktopAgentBuilderAssociationIndex>(&path)?;
    if index.version != 1 {
        return Err("Kordi Factory build associations use an unsupported version".to_string());
    }
    Ok(index)
}

fn write_associations(
    root: &Path,
    index: &DesktopAgentBuilderAssociationIndex,
) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Unable to create Kordi Factory storage: {error}"))?;
    write_json(&associations_path(root), index)
}

fn metadata_for_association(
    root: &Path,
    target_key: &str,
    association: &DesktopAgentBuilderAssociation,
) -> Result<DesktopAgentBuilderMetadata, String> {
    let container = root.join(checked_draft_id(&association.draft_id)?);
    let metadata = read_json::<DesktopAgentBuilderMetadata>(&metadata_path(&container)).map_err(|_| {
        "This Factory build session is unavailable. Recover it from the published artifact to continue."
            .to_string()
    })?;
    if metadata.target_key != target_key
        || metadata.draft_id != association.draft_id
        || metadata.session_id != association.session_id
        || metadata.status == "discarded"
    {
        return Err(
            "This Factory build association is invalid. Recover it from the published artifact to continue."
                .to_string(),
        );
    }
    Ok(metadata)
}

fn migration_candidates(root: &Path) -> Vec<DesktopAgentBuilderMetadata> {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            read_json::<DesktopAgentBuilderMetadata>(&metadata_path(&entry.path())).ok()
        })
        .filter(|metadata| metadata.status != "discarded")
        .collect()
}

fn preferred_legacy_metadata(
    candidates: impl IntoIterator<Item = DesktopAgentBuilderMetadata>,
) -> Option<DesktopAgentBuilderMetadata> {
    candidates.into_iter().max_by_key(|metadata| {
        let lifecycle_rank = if metadata.status == "draft" {
            1_i64
        } else {
            0_i64
        };
        (lifecycle_rank, metadata.updated_at_ms)
    })
}

pub(super) fn resolve_builder(
    target_key: &str,
) -> Result<Option<DesktopAgentBuilderMetadata>, String> {
    resolve_builder_in(&drafts_root(), target_key)
}

pub(super) fn resolve_builder_in(
    root: &Path,
    target_key: &str,
) -> Result<Option<DesktopAgentBuilderMetadata>, String> {
    let mut index = read_associations(root)?;
    if let Some(association) = index.associations.get(target_key) {
        return metadata_for_association(root, target_key, association).map(Some);
    }

    let metadata = preferred_legacy_metadata(
        migration_candidates(root)
            .into_iter()
            .filter(|metadata| metadata.target_key == target_key),
    );
    if let Some(metadata) = metadata.as_ref() {
        index.associations.insert(
            target_key.to_string(),
            DesktopAgentBuilderAssociation {
                draft_id: metadata.draft_id.clone(),
                session_id: metadata.session_id.clone(),
                updated_at_ms: metadata.updated_at_ms,
            },
        );
        write_associations(root, &index)?;
    }
    Ok(metadata)
}

pub(super) fn associate_builder(metadata: &DesktopAgentBuilderMetadata) -> Result<(), String> {
    let root = drafts_root();
    let mut index = read_associations(&root)?;
    index.associations.insert(
        metadata.target_key.clone(),
        DesktopAgentBuilderAssociation {
            draft_id: metadata.draft_id.clone(),
            session_id: metadata.session_id.clone(),
            updated_at_ms: metadata.updated_at_ms,
        },
    );
    write_associations(&root, &index)
}

pub(super) fn remove_builder_association(
    metadata: &DesktopAgentBuilderMetadata,
) -> Result<(), String> {
    let root = drafts_root();
    let mut index = read_associations(&root)?;
    if index
        .associations
        .get(&metadata.target_key)
        .is_some_and(|association| association.draft_id == metadata.draft_id)
    {
        index.associations.remove(&metadata.target_key);
        write_associations(&root, &index)?;
    }
    Ok(())
}

pub(super) fn retarget_builder(
    metadata: &mut DesktopAgentBuilderMetadata,
    target_key: &str,
) -> Result<(), String> {
    let root = drafts_root();
    let mut index = read_associations(&root)?;
    if let Some(existing) = index.associations.get(target_key) {
        if existing.draft_id != metadata.draft_id {
            return Err(
                "That artifact already belongs to another Factory build session".to_string(),
            );
        }
    }
    if index
        .associations
        .get(&metadata.target_key)
        .is_some_and(|association| association.draft_id == metadata.draft_id)
    {
        index.associations.remove(&metadata.target_key);
    }
    metadata.target_key = target_key.to_string();
    index.associations.insert(
        metadata.target_key.clone(),
        DesktopAgentBuilderAssociation {
            draft_id: metadata.draft_id.clone(),
            session_id: metadata.session_id.clone(),
            updated_at_ms: metadata.updated_at_ms,
        },
    );
    write_associations(&root, &index)
}

pub(super) fn all_builder_associations() -> Result<
    Vec<(
        String,
        DesktopAgentBuilderAssociation,
        Option<DesktopAgentBuilderMetadata>,
    )>,
    String,
> {
    let root = drafts_root();
    let mut index = read_associations(&root)?;
    let mut candidates_by_target = HashMap::<String, Vec<DesktopAgentBuilderMetadata>>::new();
    for metadata in migration_candidates(&root) {
        candidates_by_target
            .entry(metadata.target_key.clone())
            .or_default()
            .push(metadata);
    }
    let missing: BTreeMap<_, _> = candidates_by_target
        .into_iter()
        .filter(|(target_key, _)| !index.associations.contains_key(target_key))
        .filter_map(|(target_key, candidates)| {
            preferred_legacy_metadata(candidates).map(|metadata| {
                let association = DesktopAgentBuilderAssociation {
                    draft_id: metadata.draft_id.clone(),
                    session_id: metadata.session_id.clone(),
                    updated_at_ms: metadata.updated_at_ms,
                };
                (target_key, association)
            })
        })
        .collect();
    if !missing.is_empty() {
        index.associations.extend(missing);
        write_associations(&root, &index)?;
    }
    Ok(index
        .associations
        .into_iter()
        .map(|(target_key, association)| {
            let metadata = metadata_for_association(&root, &target_key, &association).ok();
            (target_key, association, metadata)
        })
        .collect())
}

pub(super) fn new_metadata(target_key: &str) -> DesktopAgentBuilderMetadata {
    let draft_id = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    DesktopAgentBuilderMetadata {
        session_id: format!("{SESSION_PREFIX}{draft_id}"),
        draft_id,
        target_key: target_key.to_string(),
        status: "draft".to_string(),
        created_at_ms: now,
        updated_at_ms: now,
    }
}

pub(super) fn read_test_report(container: &Path) -> Option<DesktopAgentBuilderTestReport> {
    read_json(&test_report_path(container)).ok()
}

pub(super) fn load_metadata(
    draft_id: &str,
) -> Result<(PathBuf, DesktopAgentBuilderMetadata), String> {
    let container = container_for_draft(draft_id)?;
    let workspace = workspace_for_draft(draft_id)?;
    let metadata = read_json(&metadata_path(&container))?;
    Ok((workspace, metadata))
}
