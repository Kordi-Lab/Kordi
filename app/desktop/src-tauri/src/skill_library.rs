use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use kordi_cli::skill_library::{
    self, SkillBundle, SkillBundleFile, SkillInstallScope, SkillLibraryDetail, SkillLibraryEntry,
};
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::chat::DesktopChatManager;

const CLAWHUB_API: &str = "https://clawhub.ai/api/v1/";
const SKILLS_SH_API: &str = "https://skills.sh/api/v1/";
const COMMUNITY_RESULT_LIMIT: usize = 40;
const MAX_COMMUNITY_FILES: usize = 128;
const MAX_COMMUNITY_FILE_BYTES: usize = 1024 * 1024;
const MAX_COMMUNITY_BUNDLE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCommunitySkillSummary {
    id: String,
    provider: String,
    owner: Option<String>,
    slug: String,
    name: String,
    description: String,
    version: Option<String>,
    downloads: u64,
    stars: u64,
    updated_at_ms: Option<i64>,
    source_url: String,
    installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCommunitySkillFile {
    path: String,
    size: u64,
    sha256: Option<String>,
    content_type: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCommunitySkillDetail {
    skill: DesktopCommunitySkillSummary,
    files: Vec<DesktopCommunitySkillFile>,
    skill_md: String,
    security_status: String,
    security_summary: String,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSearchResponse {
    #[serde(default)]
    results: Vec<ClawHubSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSearchItem {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    version: Option<String>,
    #[serde(default)]
    downloads: u64,
    updated_at: Option<i64>,
    owner_handle: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSkillEnvelope {
    skill: ClawHubSkill,
    latest_version: Option<ClawHubLatestVersion>,
    owner: Option<ClawHubOwner>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSkill {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    stats: ClawHubStats,
    updated_at: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct ClawHubStats {
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    stars: u64,
}

#[derive(Debug, Deserialize)]
struct ClawHubLatestVersion {
    version: String,
}

#[derive(Debug, Deserialize)]
struct ClawHubOwner {
    handle: String,
}

#[derive(Debug, Deserialize)]
struct ClawHubVersionEnvelope {
    version: ClawHubVersion,
}

#[derive(Debug, Deserialize)]
struct ClawHubVersion {
    version: String,
    #[serde(default)]
    files: Vec<ClawHubFile>,
    security: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubFile {
    path: String,
    size: u64,
    sha256: Option<String>,
    content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillsShSearchResponse {
    #[serde(default)]
    data: Vec<SkillsShSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsShSearchItem {
    id: String,
    slug: String,
    name: String,
    source: String,
    #[serde(default)]
    installs: u64,
    url: String,
}

#[derive(Debug, Deserialize)]
struct SkillsShDetail {
    id: String,
    source: String,
    slug: String,
    #[serde(default)]
    installs: u64,
    hash: Option<String>,
    files: Option<Vec<SkillsShFile>>,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillsShFile {
    path: String,
    contents: String,
}

#[derive(Debug, Deserialize)]
struct SkillsShAuditResponse {
    #[serde(default)]
    audits: Vec<SkillsShAudit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsShAudit {
    status: String,
    summary: String,
    risk_level: Option<String>,
}

fn cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|error| error.to_string())
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(format!("Kordi/{} skill-library", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Unable to prepare community catalog connection: {error}"))
}

async fn response_json<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Community catalog response could not be read: {error}"))?;
    if !status.is_success() {
        let message = String::from_utf8_lossy(&bytes).trim().to_string();
        return Err(if message.is_empty() {
            format!("Community catalog returned {status}")
        } else {
            format!("Community catalog returned {status}: {message}")
        });
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Community catalog returned an invalid response: {error}"))
}

fn catalog_url(base: &str, path: &str, query: &[(&str, &str)]) -> Result<Url, String> {
    let mut url = Url::parse(base)
        .and_then(|base| base.join(path))
        .map_err(|error| format!("Community catalog URL is invalid: {error}"))?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().copied());
    }
    Ok(url)
}

fn skills_sh_token() -> Result<String, String> {
    ["KORDI_SKILLS_SH_TOKEN", "VERCEL_OIDC_TOKEN"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
        .ok_or_else(|| {
            "Skills.sh browsing is not configured for this build. Use ClawHub or connect the Kordi catalog proxy.".to_string()
        })
}

fn installed_match(
    installed: &[SkillLibraryEntry],
    provider: &str,
    owner: Option<&str>,
    slug: &str,
) -> bool {
    installed.iter().any(|entry| {
        entry.provider.as_deref() == Some(provider)
            && entry.owner.as_deref() == owner
            && entry
                .source_url
                .as_deref()
                .is_some_and(|url| url.ends_with(&format!("/{slug}")))
    })
}

fn clawhub_source_url(owner: Option<&str>, slug: &str) -> String {
    owner
        .map(|owner| format!("https://clawhub.ai/{owner}/skills/{slug}"))
        .unwrap_or_else(|| format!("https://clawhub.ai/skills/{slug}"))
}

async fn clawhub_search(
    client: &Client,
    query: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        CLAWHUB_API,
        "search",
        &[
            ("q", query.trim()),
            ("nonSuspiciousOnly", "true"),
            ("limit", &limit),
        ],
    )?;
    let response: ClawHubSearchResponse = response_json(
        client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("ClawHub could not be reached: {error}"))?,
    )
    .await?;
    Ok(response
        .results
        .into_iter()
        .take(COMMUNITY_RESULT_LIMIT)
        .map(|item| {
            let owner = item.owner_handle;
            DesktopCommunitySkillSummary {
                id: format!(
                    "clawhub:{}:{}",
                    owner.as_deref().unwrap_or("unknown"),
                    item.slug
                ),
                provider: "clawhub".to_string(),
                source_url: clawhub_source_url(owner.as_deref(), &item.slug),
                installed: installed_match(installed, "clawhub", owner.as_deref(), &item.slug),
                owner,
                slug: item.slug.clone(),
                name: if item.display_name.trim().is_empty() {
                    item.slug
                } else {
                    item.display_name
                },
                description: item.summary,
                version: item.version,
                downloads: item.downloads,
                stars: 0,
                updated_at_ms: item.updated_at,
            }
        })
        .collect())
}

async fn skills_sh_search(
    client: &Client,
    query: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let token = skills_sh_token()?;
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        SKILLS_SH_API,
        "skills/search",
        &[("q", query.trim()), ("limit", &limit)],
    )?;
    let response: SkillsShSearchResponse = response_json(
        client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("Skills.sh could not be reached: {error}"))?,
    )
    .await?;
    Ok(response
        .data
        .into_iter()
        .take(COMMUNITY_RESULT_LIMIT)
        .map(|item| DesktopCommunitySkillSummary {
            id: format!("skills-sh:{}", item.id),
            provider: "skills-sh".to_string(),
            owner: Some(item.source.clone()),
            slug: item.slug.clone(),
            name: item.name,
            description: format!("Published from {}", item.source),
            version: None,
            downloads: item.installs,
            stars: 0,
            updated_at_ms: None,
            source_url: item.url,
            installed: installed_match(installed, "skills-sh", Some(&item.source), &item.slug),
        })
        .collect())
}

async fn clawhub_detail(
    client: &Client,
    owner: Option<&str>,
    slug: &str,
    requested_version: Option<&str>,
    installed: &[SkillLibraryEntry],
) -> Result<(DesktopCommunitySkillDetail, ClawHubVersion), String> {
    let detail_query = owner
        .map(|value| vec![("owner", value)])
        .unwrap_or_default();
    let detail_url = catalog_url(CLAWHUB_API, &format!("skills/{slug}"), &detail_query)?;
    let envelope: ClawHubSkillEnvelope = response_json(
        client
            .get(detail_url)
            .send()
            .await
            .map_err(|error| format!("ClawHub could not be reached: {error}"))?,
    )
    .await?;
    let owner = owner
        .map(ToOwned::to_owned)
        .or_else(|| envelope.owner.map(|value| value.handle));
    let version = requested_version
        .map(ToOwned::to_owned)
        .or_else(|| envelope.latest_version.map(|value| value.version))
        .ok_or_else(|| "ClawHub did not provide an installable version".to_string())?;
    let version_query = owner
        .as_deref()
        .map(|value| vec![("owner", value)])
        .unwrap_or_default();
    let version_url = catalog_url(
        CLAWHUB_API,
        &format!("skills/{slug}/versions/{version}"),
        &version_query,
    )?;
    let version_envelope: ClawHubVersionEnvelope = response_json(
        client
            .get(version_url)
            .send()
            .await
            .map_err(|error| format!("ClawHub version details could not be loaded: {error}"))?,
    )
    .await?;
    let security_status = version_envelope
        .version
        .security
        .as_ref()
        .and_then(|security| security.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unreviewed")
        .to_string();
    let has_warnings = version_envelope
        .version
        .security
        .as_ref()
        .and_then(|security| security.get("hasWarnings"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let security_summary = match (security_status.as_str(), has_warnings) {
        ("clean", false) => "ClawHub reports a clean scan for this version.".to_string(),
        ("clean", true) => {
            "ClawHub reports a clean scan with review notes. Inspect every file before installing."
                .to_string()
        }
        ("suspicious", _) => {
            "ClawHub marked this version as suspicious. Installation requires explicit review."
                .to_string()
        }
        _ => "No complete security verdict is available. Inspect every file before installing."
            .to_string(),
    };
    let skill_md = if envelope.skill.description.trim_start().starts_with("---") {
        envelope.skill.description.clone()
    } else {
        fetch_clawhub_file(
            client,
            owner.as_deref(),
            slug,
            &version,
            &ClawHubFile {
                path: "SKILL.md".to_string(),
                size: 0,
                sha256: None,
                content_type: Some("text/markdown".to_string()),
            },
        )
        .await
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "ClawHub SKILL.md is not valid UTF-8".to_string())
        })?
    };
    let summary = DesktopCommunitySkillSummary {
        id: format!("clawhub:{}:{}", owner.as_deref().unwrap_or("unknown"), slug),
        provider: "clawhub".to_string(),
        owner: owner.clone(),
        slug: envelope.skill.slug.clone(),
        name: if envelope.skill.display_name.trim().is_empty() {
            envelope.skill.slug.clone()
        } else {
            envelope.skill.display_name.clone()
        },
        description: envelope.skill.summary.clone(),
        version: Some(version_envelope.version.version.clone()),
        downloads: envelope.skill.stats.downloads,
        stars: envelope.skill.stats.stars,
        updated_at_ms: envelope.skill.updated_at,
        source_url: clawhub_source_url(owner.as_deref(), slug),
        installed: installed_match(installed, "clawhub", owner.as_deref(), slug),
    };
    let detail = DesktopCommunitySkillDetail {
        skill: summary,
        files: version_envelope
            .version
            .files
            .iter()
            .map(|file| DesktopCommunitySkillFile {
                path: file.path.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
                content_type: file.content_type.clone(),
            })
            .collect(),
        skill_md,
        security_status,
        security_summary,
        digest: version_envelope
            .version
            .security
            .as_ref()
            .and_then(|security| security.get("sha256hash"))
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
    };
    Ok((detail, version_envelope.version))
}

async fn skills_sh_detail(
    client: &Client,
    source: &str,
    slug: &str,
    installed: &[SkillLibraryEntry],
) -> Result<(DesktopCommunitySkillDetail, Vec<SkillsShFile>), String> {
    let token = skills_sh_token()?;
    let id = format!("{source}/{slug}");
    if id
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("Skills.sh skill identifier is invalid".to_string());
    }
    let detail_url = catalog_url(SKILLS_SH_API, &format!("skills/{id}"), &[])?;
    let detail: SkillsShDetail = response_json(
        client
            .get(detail_url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|error| format!("Skills.sh could not be reached: {error}"))?,
    )
    .await?;
    let files = detail
        .files
        .clone()
        .ok_or_else(|| "Skills.sh has no installable snapshot for this skill".to_string())?;
    let skill_md = files
        .iter()
        .find(|file| file.path == "SKILL.md")
        .map(|file| file.contents.clone())
        .ok_or_else(|| "Skills.sh snapshot does not include SKILL.md".to_string())?;
    let audit_url = catalog_url(SKILLS_SH_API, &format!("skills/audit/{id}"), &[])?;
    let audit = match client.get(audit_url).bearer_auth(&token).send().await {
        Ok(response) if response.status().is_success() => {
            response_json::<SkillsShAuditResponse>(response).await.ok()
        }
        _ => None,
    };
    let highest_risk = audit
        .as_ref()
        .and_then(|result| result.audits.iter().find(|entry| entry.status == "fail"))
        .or_else(|| {
            audit
                .as_ref()
                .and_then(|result| result.audits.iter().find(|entry| entry.status == "warn"))
        })
        .or_else(|| audit.as_ref().and_then(|result| result.audits.first()));
    let security_status = highest_risk
        .map(|entry| entry.status.clone())
        .unwrap_or_else(|| "unreviewed".to_string());
    let security_summary = highest_risk
        .map(|entry| {
            entry
                .risk_level
                .as_ref()
                .map(|risk| format!("{risk}: {}", entry.summary))
                .unwrap_or_else(|| entry.summary.clone())
        })
        .unwrap_or_else(|| {
            "No security audit is available. Inspect every file before installing.".to_string()
        });
    let name = frontmatter_field(&skill_md, "name").unwrap_or_else(|| detail.slug.clone());
    let description = frontmatter_field(&skill_md, "description").unwrap_or_default();
    let summary = DesktopCommunitySkillSummary {
        id: format!("skills-sh:{}", detail.id),
        provider: "skills-sh".to_string(),
        owner: Some(detail.source.clone()),
        slug: detail.slug.clone(),
        name,
        description,
        version: None,
        downloads: detail.installs,
        stars: 0,
        updated_at_ms: None,
        source_url: format!("https://skills.sh/{}/{}", detail.source, detail.slug),
        installed: installed_match(installed, "skills-sh", Some(&detail.source), &detail.slug),
    };
    let public_files = files
        .iter()
        .map(|file| DesktopCommunitySkillFile {
            path: file.path.clone(),
            size: file.contents.len() as u64,
            sha256: Some(hex_digest(file.contents.as_bytes())),
            content_type: Some(if file.path.ends_with(".md") {
                "text/markdown".to_string()
            } else {
                "text/plain".to_string()
            }),
        })
        .collect();
    Ok((
        DesktopCommunitySkillDetail {
            skill: summary,
            files: public_files,
            skill_md,
            security_status,
            security_summary,
            digest: detail.hash,
        },
        files,
    ))
}

async fn fetch_clawhub_file(
    client: &Client,
    owner: Option<&str>,
    slug: &str,
    version: &str,
    file: &ClawHubFile,
) -> Result<Vec<u8>, String> {
    if !safe_relative_path(&file.path) {
        return Err(format!(
            "ClawHub returned an unsafe file path: {}",
            file.path
        ));
    }
    if file.size as usize > MAX_COMMUNITY_FILE_BYTES {
        return Err(format!("{} exceeds the 1 MB per-file limit", file.path));
    }
    let mut query = vec![("path", file.path.as_str()), ("version", version)];
    if let Some(owner) = owner {
        query.push(("owner", owner));
    }
    let url = catalog_url(CLAWHUB_API, &format!("skills/{slug}/file"), &query)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Unable to download {}: {error}", file.path))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to download {}: ClawHub returned {}",
            file.path,
            response.status()
        ));
    }
    let bytes = limited_bytes(response, MAX_COMMUNITY_FILE_BYTES).await?;
    if let Some(expected) = file.sha256.as_deref() {
        let actual = hex_digest(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("{} failed checksum verification", file.path));
        }
    }
    Ok(bytes)
}

async fn limited_bytes(response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Community skill file exceeds the download limit".to_string());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Community skill download failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("Community skill file exceeds the download limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn frontmatter_field(content: &str, field: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == field {
            return Some(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    None
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn install_scope(value: &str) -> Result<SkillInstallScope, String> {
    match value.trim() {
        "global" => Ok(SkillInstallScope::Global),
        "project" => Ok(SkillInstallScope::Project),
        _ => Err("Skill install scope must be global or project".to_string()),
    }
}

#[tauri::command]
pub async fn desktop_skill_library_list() -> Result<Vec<SkillLibraryEntry>, String> {
    skill_library::list_skills(&cwd()?).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_skill_library_detail(skill_id: String) -> Result<SkillLibraryDetail, String> {
    skill_library::skill_detail(&cwd()?, &skill_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_skill_library_read_file(
    skill_id: String,
    path: String,
) -> Result<String, String> {
    skill_library::read_skill_file(&cwd()?, &skill_id, &path).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_skill_library_write_file(
    manager: State<'_, DesktopChatManager>,
    skill_id: String,
    path: String,
    content: String,
) -> Result<SkillLibraryDetail, String> {
    let detail = skill_library::write_skill_file(&cwd()?, &skill_id, &path, &content)
        .map_err(|error| error.to_string())?;
    manager.reload_skill_resources().await?;
    Ok(detail)
}

#[tauri::command]
pub async fn desktop_skill_library_set_enabled(
    manager: State<'_, DesktopChatManager>,
    name: String,
    enabled: bool,
) -> Result<Vec<SkillLibraryEntry>, String> {
    skill_library::set_skill_enabled(&name, enabled).map_err(|error| error.to_string())?;
    manager.reload_skill_resources().await?;
    desktop_skill_library_list().await
}

#[tauri::command]
pub async fn desktop_skill_library_remove(
    manager: State<'_, DesktopChatManager>,
    skill_id: String,
) -> Result<Vec<SkillLibraryEntry>, String> {
    let cwd = cwd()?;
    let removed_name = skill_library::list_skills(&cwd)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|entry| entry.id == skill_id)
        .map(|entry| entry.name);
    skill_library::remove_skill(&cwd, &skill_id).map_err(|error| error.to_string())?;
    if let Some(name) = removed_name {
        let same_name_remains = skill_library::list_skills(&cwd)
            .map_err(|error| error.to_string())?
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case(&name));
        if !same_name_remains {
            skill_library::set_skill_enabled(&name, true).map_err(|error| error.to_string())?;
        }
    }
    manager.reload_skill_resources().await?;
    skill_library::list_skills(&cwd).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_skill_community_search(
    provider: String,
    query: String,
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    let cwd = cwd()?;
    let installed = skill_library::list_skills(&cwd).map_err(|error| error.to_string())?;
    let client = http_client()?;
    match provider.trim() {
        "clawhub" => clawhub_search(&client, &query, &installed).await,
        "skills-sh" => skills_sh_search(&client, &query, &installed).await,
        _ => Err("Unknown community skill provider".to_string()),
    }
}

#[tauri::command]
pub async fn desktop_skill_community_detail(
    provider: String,
    owner: Option<String>,
    slug: String,
    version: Option<String>,
) -> Result<DesktopCommunitySkillDetail, String> {
    let installed = skill_library::list_skills(&cwd()?).map_err(|error| error.to_string())?;
    let client = http_client()?;
    match provider.trim() {
        "clawhub" => clawhub_detail(
            &client,
            owner.as_deref(),
            slug.trim(),
            version.as_deref(),
            &installed,
        )
        .await
        .map(|(detail, _)| detail),
        "skills-sh" => skills_sh_detail(
            &client,
            owner
                .as_deref()
                .ok_or_else(|| "Skills.sh source is required".to_string())?,
            slug.trim(),
            &installed,
        )
        .await
        .map(|(detail, _)| detail),
        _ => Err("Unknown community skill provider".to_string()),
    }
}

#[tauri::command]
pub async fn desktop_skill_community_install(
    manager: State<'_, DesktopChatManager>,
    provider: String,
    owner: Option<String>,
    slug: String,
    version: Option<String>,
    scope: String,
) -> Result<SkillLibraryEntry, String> {
    let cwd = cwd()?;
    let installed_before = skill_library::list_skills(&cwd).map_err(|error| error.to_string())?;
    let client = http_client()?;
    let install_scope = install_scope(&scope)?;
    let (detail, files) = match provider.trim() {
        "clawhub" => {
            let (detail, version_detail) = clawhub_detail(
                &client,
                owner.as_deref(),
                slug.trim(),
                version.as_deref(),
                &installed_before,
            )
            .await?;
            if version_detail.files.len() > MAX_COMMUNITY_FILES {
                return Err(format!(
                    "This skill has more than {MAX_COMMUNITY_FILES} files and cannot be installed safely"
                ));
            }
            let mut total = 0usize;
            let mut bundle_files = Vec::with_capacity(version_detail.files.len());
            for file in &version_detail.files {
                let bytes = fetch_clawhub_file(
                    &client,
                    detail.skill.owner.as_deref(),
                    &detail.skill.slug,
                    detail
                        .skill
                        .version
                        .as_deref()
                        .unwrap_or(&version_detail.version),
                    file,
                )
                .await?;
                total = total.saturating_add(bytes.len());
                if total > MAX_COMMUNITY_BUNDLE_BYTES {
                    return Err("Community skill bundle exceeds the 4 MB limit".to_string());
                }
                bundle_files.push(SkillBundleFile {
                    path: file.path.clone(),
                    bytes,
                });
            }
            (detail, bundle_files)
        }
        "skills-sh" => {
            let (detail, source_files) = skills_sh_detail(
                &client,
                owner
                    .as_deref()
                    .ok_or_else(|| "Skills.sh source is required".to_string())?,
                slug.trim(),
                &installed_before,
            )
            .await?;
            let total = source_files
                .iter()
                .map(|file| file.contents.len())
                .sum::<usize>();
            if source_files.len() > MAX_COMMUNITY_FILES || total > MAX_COMMUNITY_BUNDLE_BYTES {
                return Err(
                    "Community skill bundle exceeds Kordi's safe install limits".to_string()
                );
            }
            let files = source_files
                .into_iter()
                .map(|file| SkillBundleFile {
                    path: file.path,
                    bytes: file.contents.into_bytes(),
                })
                .collect();
            (detail, files)
        }
        _ => return Err("Unknown community skill provider".to_string()),
    };

    let previously_installed = detail.skill.installed;
    let entry = skill_library::install_skill_bundle(
        &cwd,
        install_scope,
        SkillBundle {
            name: detail.skill.name.clone(),
            description: detail.skill.description.clone(),
            slug: detail.skill.slug.clone(),
            origin: "community".to_string(),
            provider: Some(detail.skill.provider.clone()),
            owner: detail.skill.owner.clone(),
            version: detail.skill.version.clone(),
            source_url: Some(detail.skill.source_url.clone()),
            digest: detail.digest.clone(),
            files,
        },
    )
    .map_err(|error| error.to_string())?;
    if !previously_installed {
        skill_library::set_skill_enabled(&entry.name, false).map_err(|error| error.to_string())?;
    }
    manager.reload_skill_resources().await?;
    skill_library::list_skills(&cwd)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|candidate| candidate.id == entry.id)
        .ok_or_else(|| "Installed skill could not be reloaded".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn community_paths_reject_parent_and_absolute_components() {
        assert!(safe_relative_path("SKILL.md"));
        assert!(safe_relative_path("scripts/check.sh"));
        assert!(!safe_relative_path("../escape.sh"));
        assert!(!safe_relative_path("/tmp/escape.sh"));
    }

    #[test]
    fn frontmatter_values_are_unquoted() {
        let content = "---\nname: example\ndescription: \"A useful skill\"\n---\n";
        assert_eq!(
            frontmatter_field(content, "name").as_deref(),
            Some("example")
        );
        assert_eq!(
            frontmatter_field(content, "description").as_deref(),
            Some("A useful skill")
        );
    }
}
