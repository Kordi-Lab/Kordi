use std::{cmp::Reverse, collections::BTreeMap};

use super::*;

fn unscoped_target(target_key: &str) -> &str {
    if let Some(target) = target_key.strip_prefix("device:") {
        return target;
    }
    if let Some(account_target) = target_key.strip_prefix("account:") {
        return account_target
            .split_once(':')
            .map(|(_, target)| target)
            .unwrap_or(target_key);
    }
    target_key
}

pub(super) fn artifact_kind_from_target(target_key: &str) -> String {
    let target = unscoped_target(target_key);
    for kind in ["agent", "skill", "tool", "plugin"] {
        if target.starts_with(&format!("{kind}:"))
            || target.starts_with(&format!("create:{kind}:"))
            || target.ends_with(&format!("-{kind}"))
        {
            return kind.to_string();
        }
    }
    "agent".to_string()
}

pub(super) fn fallback_name_from_target(target_key: &str, artifact_kind: &str) -> String {
    let target = unscoped_target(target_key);
    let raw = target
        .strip_prefix(&format!("{artifact_kind}:"))
        .or_else(|| target.strip_prefix(&format!("create:{artifact_kind}:")))
        .unwrap_or(artifact_kind);
    raw.replace(['-', '_'], " ")
}

fn summary_from_metadata(metadata: &DesktopAgentBuilderMetadata) -> DesktopAgentBuilderSummary {
    let artifact_kind = artifact_kind_from_target(&metadata.target_key);
    let status = status_from_metadata(metadata).ok();
    let name = status
        .as_ref()
        .and_then(|status| status.draft.as_ref())
        .map(|draft| match artifact_kind.as_str() {
            "skill" => draft
                .skills
                .first()
                .map(|skill| skill.name.clone())
                .unwrap_or_else(|| draft.name.clone()),
            "tool" => draft
                .tools
                .first()
                .cloned()
                .unwrap_or_else(|| draft.name.clone()),
            "plugin" => draft
                .plugins
                .first()
                .cloned()
                .unwrap_or_else(|| draft.name.clone()),
            _ => draft.name.clone(),
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| fallback_name_from_target(&metadata.target_key, &artifact_kind));
    DesktopAgentBuilderSummary {
        draft_id: metadata.draft_id.clone(),
        target_key: metadata.target_key.clone(),
        session_id: metadata.session_id.clone(),
        artifact_kind,
        name,
        lifecycle: metadata.status.clone(),
        updated_at_ms: metadata.updated_at_ms,
        available: true,
    }
}

fn is_creation_target(target_key: &str) -> bool {
    let target = unscoped_target(target_key);
    target.starts_with("create:")
        || ["agent", "skill", "tool", "plugin"]
            .iter()
            .any(|kind| target == format!("create-{kind}"))
}

pub(super) fn is_untouched_creation(metadata: &DesktopAgentBuilderMetadata) -> bool {
    metadata.status == "draft"
        && metadata.updated_at_ms <= metadata.created_at_ms
        && is_creation_target(&metadata.target_key)
}

pub(super) fn deduplicate_builder_summaries(
    summaries: impl IntoIterator<Item = DesktopAgentBuilderSummary>,
) -> Vec<DesktopAgentBuilderSummary> {
    let mut summaries_by_target = BTreeMap::<String, DesktopAgentBuilderSummary>::new();
    for summary in summaries {
        let identity = unscoped_target(&summary.target_key).to_string();
        let replace = summaries_by_target.get(&identity).is_none_or(|current| {
            (summary.available, summary.updated_at_ms) > (current.available, current.updated_at_ms)
        });
        if replace {
            summaries_by_target.insert(identity, summary);
        }
    }
    let mut summaries = summaries_by_target.into_values().collect::<Vec<_>>();
    summaries.sort_by_key(|summary| Reverse(summary.updated_at_ms));
    summaries
}

async fn open_builder_metadata(
    manager: &DesktopChatManager,
    mut metadata: DesktopAgentBuilderMetadata,
    seed: Option<&DesktopAgentBuilderSeed>,
) -> Result<DesktopAgentBuilderOpenResult, String> {
    if metadata.status == "published" {
        metadata.status = "draft".to_string();
        metadata.updated_at_ms = now_millis();
    }
    let container = container_for_draft(&metadata.draft_id)?;
    let workspace = workspace_for_draft(&metadata.draft_id)?;
    fs::create_dir_all(&container)
        .map_err(|error| format!("Unable to create Kordi Factory draft: {error}"))?;
    migrate_legacy_workspace(&container, &workspace)?;
    materialize_builder_skills(&container)?;
    materialize_seed(&workspace, seed)?;
    write_metadata(&workspace, &metadata)?;
    associate_builder(&metadata)?;
    let handle = load_or_create_runtime(manager, &metadata, &workspace).await?;
    let session = handle
        .lock()
        .await
        .detail()
        .map_err(|error| error.to_string())?;
    Ok(DesktopAgentBuilderOpenResult {
        status: status_from_metadata(&metadata)?,
        session,
    })
}

#[tauri::command]
pub async fn desktop_agent_builder_list() -> Result<Vec<DesktopAgentBuilderSummary>, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let summaries = all_builder_associations()?
        .into_iter()
        .filter_map(|(target_key, association, metadata)| match metadata {
            Some(metadata) if is_untouched_creation(&metadata) => None,
            Some(metadata) => Some(summary_from_metadata(&metadata)),
            None => {
                let artifact_kind = artifact_kind_from_target(&target_key);
                Some(DesktopAgentBuilderSummary {
                    draft_id: association.draft_id,
                    session_id: association.session_id,
                    name: fallback_name_from_target(&target_key, &artifact_kind),
                    target_key,
                    artifact_kind,
                    lifecycle: "unavailable".to_string(),
                    updated_at_ms: association.updated_at_ms,
                    available: false,
                })
            }
        })
        .collect::<Vec<_>>();
    Ok(deduplicate_builder_summaries(summaries))
}

#[tauri::command]
pub async fn desktop_agent_builder_resolve(
    target_key: String,
) -> Result<Option<DesktopAgentBuilderSummary>, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    if target_key.is_empty() || target_key.len() > 240 {
        return Err("Kordi Factory target is invalid".to_string());
    }
    resolve_builder(target_key).map(|metadata| metadata.as_ref().map(summary_from_metadata))
}

#[tauri::command]
pub async fn desktop_agent_builder_open(
    manager: State<'_, DesktopChatManager>,
    target_key: String,
    seed: Option<DesktopAgentBuilderSeed>,
) -> Result<DesktopAgentBuilderOpenResult, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    if target_key.is_empty() || target_key.len() > 240 {
        return Err("Kordi Factory target is invalid".to_string());
    }
    fs::create_dir_all(drafts_root())
        .map_err(|error| format!("Unable to create Kordi Factory storage: {error}"))?;

    let metadata = resolve_builder(target_key)?.unwrap_or_else(|| new_metadata(target_key));
    open_builder_metadata(manager.inner(), metadata, seed.as_ref()).await
}

#[tauri::command]
pub async fn desktop_agent_builder_open_session(
    manager: State<'_, DesktopChatManager>,
    target_key: String,
    session_id: String,
    seed: Option<DesktopAgentBuilderSeed>,
) -> Result<DesktopAgentBuilderOpenResult, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    let session_id = session_id.trim();
    let metadata = resolve_builder(target_key)?.ok_or_else(|| {
        "This Factory build is no longer associated with the selected artifact. Recover it to continue."
            .to_string()
    })?;
    if metadata.session_id != session_id {
        return Err(
            "This Factory build points to a different session. Recover the selected artifact to continue."
                .to_string(),
        );
    }
    open_builder_metadata(manager.inner(), metadata, seed.as_ref()).await
}

#[tauri::command]
pub async fn desktop_agent_builder_recover(
    manager: State<'_, DesktopChatManager>,
    target_key: String,
    seed: DesktopAgentBuilderSeed,
) -> Result<DesktopAgentBuilderOpenResult, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    if target_key.is_empty() || target_key.len() > 240 {
        return Err("Kordi Factory target is invalid".to_string());
    }
    open_builder_metadata(manager.inner(), new_metadata(target_key), Some(&seed)).await
}

#[tauri::command]
pub async fn desktop_agent_builder_retarget(
    draft_id: String,
    target_key: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    if target_key.is_empty() || target_key.len() > 240 {
        return Err("Kordi Factory target is invalid".to_string());
    }
    let (workspace, mut metadata) = load_metadata(&draft_id)?;
    retarget_builder(&mut metadata, target_key)?;
    metadata.updated_at_ms = now_millis();
    write_metadata(&workspace, &metadata)?;
    associate_builder(&metadata)?;
    status_from_metadata(&metadata)
}
