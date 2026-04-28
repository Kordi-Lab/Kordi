use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioCommandResult {
    pub command: String,
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioCatalogVariant {
    pub id: String,
    pub name: String,
    pub url: String,
    pub size: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioInstalledModel {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
    pub path: Option<String>,
    pub architecture: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioEnvironment {
    pub app_path: Option<String>,
    pub app_version: Option<String>,
    pub home_path: Option<String>,
    pub bin_path: Option<String>,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub cli_source: Option<String>,
    pub cli_in_shell_path: bool,
    pub shell_config_paths: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioServerStatus {
    pub running: bool,
    pub detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLmStudioCatalogModel {
    pub id: String,
    pub name: String,
    pub url: String,
    pub sizes: Vec<String>,
    pub updated: Option<String>,
    pub variants: Vec<DesktopLmStudioCatalogVariant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LmStudioLoadedModelInstance {
    model_id: String,
    identifier: String,
    context_length: Option<u64>,
    max_context_length: Option<u64>,
}

const MAX_COMMAND_OUTPUT_BYTES: usize = 12_000;
const LM_STUDIO_CONTEXT_SEARCH_STEP: u64 = 1024;
const LM_STUDIO_UNLOAD_POLL_ATTEMPTS: usize = 20;
const LM_STUDIO_UNLOAD_POLL_DELAY_MS: u64 = 250;
const LM_STUDIO_INSTALL_COMMAND: &str = "curl -fsSL https://lmstudio.ai/install.sh | bash";
const LM_STUDIO_MODELS_URL: &str = "https://lmstudio.ai/models";

#[tauri::command]
pub async fn desktop_lm_studio_environment() -> Result<DesktopLmStudioEnvironment, String> {
    Ok(lm_studio_environment())
}

#[tauri::command]
pub async fn desktop_lm_studio_open_app() -> Result<DesktopLmStudioCommandResult, String> {
    let app_path = find_lm_studio_app_path().ok_or_else(|| {
        "LM Studio.app was not found in /Applications or ~/Applications.".to_string()
    })?;
    let mut command = Command::new("/usr/bin/open");
    command.arg(&app_path);
    run_command(command, format!("open {}", app_path.display())).await
}

#[tauri::command]
pub async fn desktop_lm_studio_repair_cli_path() -> Result<DesktopLmStudioCommandResult, String> {
    let bin_path = find_lm_studio_bin_dir().ok_or_else(|| {
        "LM Studio CLI files were not found. Open LM Studio once, then try adding lms to PATH again."
            .to_string()
    })?;
    let updated = add_lm_studio_bin_to_shell_path(&bin_path)?;
    let stdout = if updated.is_empty() {
        format!(
            "LM Studio CLI path is already configured: {}",
            bin_path.display()
        )
    } else {
        format!(
            "Added LM Studio CLI path {} to:\n{}",
            bin_path.display(),
            updated
                .iter()
                .map(|path| format!("- {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(DesktopLmStudioCommandResult {
        command: format!("add {} to shell PATH", bin_path.display()),
        status_code: Some(0),
        stdout,
        stderr: String::new(),
    })
}

#[tauri::command]
pub async fn desktop_lm_studio_catalog_models() -> Result<Vec<DesktopLmStudioCatalogModel>, String>
{
    let client = reqwest::Client::new();
    let html = client
        .get(LM_STUDIO_MODELS_URL)
        .header(reqwest::header::USER_AGENT, "Kordi desktop")
        .send()
        .await
        .map_err(|err| format!("Unable to fetch LM Studio catalog: {err}"))?
        .error_for_status()
        .map_err(|err| format!("LM Studio catalog returned an error: {err}"))?
        .text()
        .await
        .map_err(|err| format!("Unable to read LM Studio catalog: {err}"))?;

    let models = parse_catalog_models(&html);
    let mut models = stream::iter(models.into_iter().map(|mut model| {
        let client = client.clone();
        async move {
            if let Ok(page) = client
                .get(&model.url)
                .header(reqwest::header::USER_AGENT, "Kordi desktop")
                .send()
                .await
                .and_then(|response| response.error_for_status())
            {
                if let Ok(page_html) = page.text().await {
                    model.variants = parse_catalog_variants(&page_html);
                }
            }
            model
        }
    }))
    .buffer_unordered(6)
    .collect::<Vec<_>>()
    .await;

    models.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    if models.is_empty() {
        Err("LM Studio catalog did not include any models.".to_string())
    } else {
        Ok(models)
    }
}

#[tauri::command]
pub async fn desktop_lm_studio_loaded_model_ids(base_url: String) -> Result<Vec<String>, String> {
    loaded_model_ids_for_base_url(&base_url).await
}

#[tauri::command]
pub async fn desktop_lm_studio_server_status() -> Result<DesktopLmStudioServerStatus, String> {
    lm_studio_server_status().await
}

#[tauri::command]
pub async fn desktop_lm_studio_start_server(
    port: Option<u32>,
) -> Result<DesktopLmStudioCommandResult, String> {
    start_lm_studio_server(port).await
}

#[tauri::command]
pub async fn desktop_lm_studio_stop_server() -> Result<DesktopLmStudioCommandResult, String> {
    let mut command = lms_command()?;
    command.arg("server").arg("stop");
    run_command(command, "lms server stop".to_string()).await
}

pub async fn ensure_server_running(port: Option<u32>) -> Result<(), String> {
    let status = lm_studio_server_status().await?;
    if status.running {
        return Ok(());
    }

    start_lm_studio_server(port).await?;
    let status = lm_studio_server_status().await?;
    if status.running {
        Ok(())
    } else {
        Err(format!(
            "LM Studio local server did not report as running after start. {}",
            status.detail
        ))
    }
}

pub async fn loaded_model_ids_for_base_url(base_url: &str) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let mut errors = Vec::new();
    let mut had_success = false;

    match fetch_lm_studio_rest_loaded_llm_ids(base_url).await {
        Ok(rest_ids) => {
            had_success = true;
            ids.extend(rest_ids);
        }
        Err(rest_error) => match fetch_openai_loaded_model_ids(base_url).await {
            Ok(openai_ids) => {
                had_success = true;
                ids.extend(
                    openai_ids
                        .into_iter()
                        .filter(|id| !is_lm_studio_embedding_model_id(id))
                        .map(|id| canonical_lm_studio_model_id(&id)),
                );
            }
            Err(openai_error) => errors.push(format!("{rest_error} {openai_error}")),
        },
    }

    match fetch_lms_ps_model_ids().await {
        Ok(cli_ids) => {
            had_success = true;
            ids.extend(cli_ids);
        }
        Err(error) => errors.push(error),
    }

    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();

    if had_success {
        Ok(ids)
    } else {
        Err(errors.join(" "))
    }
}

#[tauri::command]
pub async fn desktop_lm_studio_installed_models(
) -> Result<Vec<DesktopLmStudioInstalledModel>, String> {
    let mut command = lms_command()?;
    command.arg("ls").arg("--json");
    let result = run_command(command, "lms ls --json".to_string()).await?;
    parse_installed_models(&result.stdout)
}

#[tauri::command]
pub async fn desktop_lm_studio_install() -> Result<DesktopLmStudioCommandResult, String> {
    if !cfg!(target_family = "unix") {
        return Err(
            "One-click LM Studio install is currently supported on macOS and Linux.".to_string(),
        );
    }

    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(LM_STUDIO_INSTALL_COMMAND);
    run_command(command, LM_STUDIO_INSTALL_COMMAND.to_string()).await
}

#[tauri::command]
pub async fn desktop_lm_studio_get_model(
    model: String,
) -> Result<DesktopLmStudioCommandResult, String> {
    let model = sanitize_model_arg(&model)?;
    let mut command = lms_command()?;
    command.arg("get").arg(&model);
    run_command(command, format!("lms get {model}")).await
}

#[tauri::command]
pub async fn desktop_lm_studio_load_model(
    model: String,
) -> Result<DesktopLmStudioCommandResult, String> {
    load_lm_studio_model_with_best_context(&model).await
}

#[tauri::command]
pub async fn desktop_lm_studio_stop_model(
    model: String,
) -> Result<DesktopLmStudioCommandResult, String> {
    unload_lm_studio_model_instances(&model).await
}

pub async fn ensure_model_loaded_with_best_context(model: &str) -> Result<(), String> {
    load_lm_studio_model_with_best_context(model)
        .await
        .map(|_| ())
}

fn lm_studio_environment() -> DesktopLmStudioEnvironment {
    let app_path = find_lm_studio_app_path();
    let app_version = app_path.as_deref().and_then(lm_studio_app_version);
    let home_path = find_lm_studio_home_dir();
    let bin_path = find_lm_studio_bin_dir();
    let lms_path = resolve_lms_path();
    let shell_path = shell_command_path("lms");
    let shell_config_paths = bin_path
        .as_deref()
        .map(shell_configs_containing_path)
        .unwrap_or_default();
    let cli_in_shell_path = shell_path.is_some() || !shell_config_paths.is_empty();
    let cli_version = lms_path
        .as_ref()
        .and_then(|resolved| lms_version(&resolved.path));
    let mut notes = Vec::new();

    if app_path.is_none() {
        notes.push("LM Studio.app was not found in /Applications or ~/Applications.".to_string());
    }
    if home_path.is_none() {
        notes.push(
            "LM Studio home was not found. Open LM Studio once so it creates its CLI files."
                .to_string(),
        );
    }
    if lms_path.is_none() {
        notes.push(
            "The lms CLI was not found. Use Add lms to PATH after opening LM Studio once."
                .to_string(),
        );
    } else if shell_path.is_none() {
        notes.push(
            "Kordi can use lms directly, but your shell PATH does not expose it yet.".to_string(),
        );
    }

    DesktopLmStudioEnvironment {
        app_path: app_path.map(path_to_string),
        app_version,
        home_path: home_path.map(path_to_string),
        bin_path: bin_path.map(path_to_string),
        cli_path: lms_path
            .as_ref()
            .map(|resolved| path_to_string(resolved.path.clone())),
        cli_version,
        cli_source: lms_path.map(|resolved| resolved.source),
        cli_in_shell_path,
        shell_config_paths: shell_config_paths.into_iter().map(path_to_string).collect(),
        notes,
    }
}

struct ResolvedCommandPath {
    path: PathBuf,
    source: String,
}

fn lms_command() -> Result<Command, String> {
    let resolved = resolve_lms_path().ok_or_else(|| {
        "LM Studio CLI `lms` was not found. Open LM Studio once, then click Add lms to PATH in Kordi."
            .to_string()
    })?;
    Ok(Command::new(resolved.path))
}

fn resolve_lms_path() -> Option<ResolvedCommandPath> {
    if let Some(path) = find_lm_studio_bin_dir()
        .map(|dir| dir.join("lms"))
        .filter(|path| path.is_file())
    {
        return Some(ResolvedCommandPath {
            path,
            source: "lm-studio-home".to_string(),
        });
    }

    if let Some(path) = shell_command_path("lms") {
        return Some(ResolvedCommandPath {
            path,
            source: "shell-path".to_string(),
        });
    }

    for candidate in [
        "/opt/homebrew/bin/lms",
        "/usr/local/bin/lms",
        "/usr/bin/lms",
        "/bin/lms",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(ResolvedCommandPath {
                path,
                source: "common-path".to_string(),
            });
        }
    }

    None
}

fn find_lm_studio_home_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let pointer = home.join(".lmstudio-home-pointer");
    if let Ok(value) = fs::read_to_string(pointer) {
        let path = PathBuf::from(value.trim());
        if path.is_dir() {
            return Some(path);
        }
    }

    for candidate in [home.join(".cache/lm-studio"), home.join(".lmstudio")] {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    None
}

fn find_lm_studio_bin_dir() -> Option<PathBuf> {
    let path = find_lm_studio_home_dir()?.join("bin");
    path.is_dir().then_some(path)
}

fn find_lm_studio_app_path() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications/LM Studio.app")];
    if let Some(home) = home_dir() {
        candidates.push(home.join("Applications/LM Studio.app"));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn lm_studio_app_version(app_path: &Path) -> Option<String> {
    let info_plist = fs::read_to_string(app_path.join("Contents/Info.plist")).ok()?;
    plist_string_value(&info_plist, "CFBundleShortVersionString")
        .or_else(|| plist_string_value(&info_plist, "CFBundleVersion"))
}

fn plist_string_value(contents: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let tail = contents.split_once(&marker)?.1;
    let string_start = tail.find("<string>")? + "<string>".len();
    let string_tail = &tail[string_start..];
    let string_end = string_tail.find("</string>")?;
    let value = html_text(&string_tail[..string_end]);
    (!value.is_empty()).then_some(value)
}

fn lms_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    });
    let version = text.trim().lines().next().unwrap_or_default().trim();
    (!version.is_empty()).then(|| version.to_string())
}

fn shell_command_path(command: &str) -> Option<PathBuf> {
    let script = format!("command -v {command}");
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        let Ok(output) = Command::new(shell).arg("-lc").arg(&script).output() else {
            continue;
        };
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout);
            let path = value.trim().lines().next().unwrap_or_default().trim();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

fn add_lm_studio_bin_to_shell_path(bin_path: &Path) -> Result<Vec<PathBuf>, String> {
    let home = home_dir().ok_or_else(|| "Unable to locate your home directory.".to_string())?;
    let targets = [".zshrc", ".bash_profile", ".bashrc", ".profile"];
    let mut existing = targets
        .iter()
        .map(|name| home.join(name))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    if existing.is_empty() {
        existing.push(home.join(".zshrc"));
    }

    let mut updated = Vec::new();
    let bin_value = bin_path.to_string_lossy();
    let line = format!("export PATH=\"$PATH:{bin_value}\"");

    for config_path in existing {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        if content.contains(bin_value.as_ref()) {
            continue;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config_path)
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        writeln!(file).ok();
        writeln!(file, "# Added by Kordi for LM Studio CLI (lms)")
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        writeln!(file, "{line}")
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        updated.push(config_path);
    }

    Ok(updated)
}

fn shell_configs_containing_path(bin_path: &Path) -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let bin_value = bin_path.to_string_lossy();
    [".zshrc", ".bash_profile", ".bashrc", ".profile"]
        .iter()
        .map(|name| home.join(name))
        .filter(|path| {
            fs::read_to_string(path).is_ok_and(|content| content.contains(bin_value.as_ref()))
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

async fn fetch_lm_studio_rest_loaded_llm_ids(base_url: &str) -> Result<Vec<String>, String> {
    let models_url = lm_studio_rest_models_endpoint(base_url)?;
    let response = reqwest::Client::new()
        .get(models_url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|err| format!("Unable to contact LM Studio REST model list: {err}"))?
        .error_for_status()
        .map_err(|err| format!("LM Studio REST model list returned an error: {err}"))?;

    let json = response
        .json::<Value>()
        .await
        .map_err(|err| format!("Unable to read LM Studio REST model list: {err}"))?;
    let mut ids = Vec::new();
    collect_rest_loaded_llm_model_ids(&json, &mut ids);
    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();
    Ok(ids)
}

async fn fetch_openai_loaded_model_ids(base_url: &str) -> Result<Vec<String>, String> {
    let models_url = lm_studio_models_endpoint(base_url)?;
    let response = reqwest::Client::new()
        .get(models_url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|err| format!("Unable to contact LM Studio local server: {err}"))?
        .error_for_status()
        .map_err(|err| format!("LM Studio local server returned an error: {err}"))?;

    let json = response
        .json::<Value>()
        .await
        .map_err(|err| format!("Unable to read LM Studio loaded models: {err}"))?;
    Ok(json
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect())
}

async fn fetch_lms_ps_model_ids() -> Result<Vec<String>, String> {
    let mut command = lms_command()?;
    command.arg("ps").arg("--json");
    let result = run_command(command, "lms ps --json".to_string()).await?;
    parse_model_ids(&result.stdout)
}

async fn fetch_lms_ps_instances() -> Result<Vec<LmStudioLoadedModelInstance>, String> {
    let mut command = lms_command()?;
    command.arg("ps").arg("--json");
    let result = run_command(command, "lms ps --json".to_string()).await?;
    parse_loaded_model_instances(&result.stdout)
}

async fn installed_model_max_context_length(model: &str) -> Result<Option<u64>, String> {
    let mut command = lms_command()?;
    command.arg("ls").arg("--json");
    let result = run_command(command, "lms ls --json".to_string()).await?;
    let json = serde_json::from_str::<Value>(result.stdout.trim()).map_err(|err| {
        format!("Unable to read `lms ls --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    Ok(model_max_context_length_from_value(&json, model))
}

async fn load_lm_studio_model_with_best_context(
    model: &str,
) -> Result<DesktopLmStudioCommandResult, String> {
    let model = sanitize_model_arg(model)?;
    let desired_identifier = lm_studio_model_match_key(&model);
    let loaded_instances = fetch_lms_ps_instances().await.unwrap_or_default();
    let max_context = installed_model_max_context_length(&model)
        .await?
        .or_else(|| {
            loaded_instances
                .iter()
                .filter(|instance| lm_studio_model_ids_match(&instance.model_id, &model))
                .filter_map(|instance| instance.max_context_length)
                .max()
        })
        .ok_or_else(|| {
            format!(
                "LM Studio did not report a maximum context length for `{model}`. Update LM Studio, then try Run again."
            )
        })?;

    if loaded_instances.iter().any(|instance| {
        instance.identifier == desired_identifier
            && instance
                .context_length
                .is_some_and(|context| context >= max_context)
    }) {
        return Ok(DesktopLmStudioCommandResult {
            command: format!(
                "lms load {model} --context-length {max_context} --identifier {desired_identifier} --yes"
            ),
            status_code: Some(0),
            stdout: format!(
                "`{model}` is already loaded as `{desired_identifier}` with the maximum supported context length ({max_context} tokens)."
            ),
            stderr: String::new(),
        });
    }

    let had_loaded_match = loaded_instances.iter().any(|instance| {
        lm_studio_model_ids_match(&instance.model_id, &model)
            || instance.identifier == desired_identifier
    });
    let mut unloaded = unload_matching_lm_studio_instances(&model, loaded_instances).await?;
    if had_loaded_match {
        if !unloaded
            .iter()
            .any(|identifier| identifier == &desired_identifier)
        {
            unload_lm_studio_identifier(&desired_identifier).await?;
            unloaded.push(desired_identifier.clone());
        }
        wait_for_lm_studio_model_unloaded(&model, &desired_identifier).await?;
    }

    let best_context = best_loadable_lm_studio_context(&model, max_context, &desired_identifier)
        .await
        .map_err(|err| {
            let unloaded_note = if unloaded.is_empty() {
                String::new()
            } else {
                format!(" Unloaded existing 4096-token instances first: {}.", unloaded.join(", "))
            };
            format!(
                "Could not find a loadable context length for `{model}` up to its advertised maximum ({max_context} tokens).{unloaded_note} {err}"
            )
        })?;

    let mut errors = Vec::new();
    for context_length in load_context_fallbacks(best_context) {
        match run_lm_studio_load_context(&model, context_length, &desired_identifier).await {
            Ok(mut result) => {
                let prefix = if context_length == max_context {
                    format!("Loaded `{model}` at its maximum supported context length ({context_length} tokens).")
                } else {
                    format!("Loaded `{model}` at the largest context length LM Studio estimated as loadable ({context_length} of {max_context} tokens).")
                };
                let unload_note = if unloaded.is_empty() {
                    String::new()
                } else {
                    format!(" Replaced existing instances: {}.", unloaded.join(", "))
                };
                result.stdout = if result.stdout.trim().is_empty() {
                    format!("{prefix}{unload_note}")
                } else {
                    format!("{prefix}{unload_note}\n{}", result.stdout)
                };
                return Ok(result);
            }
            Err(err) if is_lm_studio_identifier_exists_error(&err) => {
                unload_lm_studio_identifier(&desired_identifier).await?;
                wait_for_lm_studio_model_unloaded(&model, &desired_identifier).await?;
                match run_lm_studio_load_context(&model, context_length, &desired_identifier).await
                {
                    Ok(mut result) => {
                        result.stdout = if result.stdout.trim().is_empty() {
                            format!("Loaded `{model}` at {context_length} tokens after clearing the stale LM Studio identifier `{desired_identifier}`.")
                        } else {
                            format!("Loaded `{model}` at {context_length} tokens after clearing the stale LM Studio identifier `{desired_identifier}`.\n{}", result.stdout)
                        };
                        return Ok(result);
                    }
                    Err(retry_err) => errors.push(format!(
                        "{context_length} tokens after unloading stale identifier: {retry_err}"
                    )),
                }
            }
            Err(err) => errors.push(format!("{context_length} tokens: {err}")),
        }
    }

    Err(format!(
        "LM Studio estimated `{model}` could load at {best_context} tokens, but loading failed. Attempts: {}",
        errors.join(" | ")
    ))
}

async fn run_lm_studio_load_context(
    model: &str,
    context_length: u64,
    desired_identifier: &str,
) -> Result<DesktopLmStudioCommandResult, String> {
    let mut command = lms_command()?;
    command
        .arg("load")
        .arg(model)
        .arg("--context-length")
        .arg(context_length.to_string())
        .arg("--identifier")
        .arg(desired_identifier)
        .arg("--yes");
    run_command(
        command,
        format!(
            "lms load {model} --context-length {context_length} --identifier {desired_identifier} --yes"
        ),
    )
    .await
}

fn is_lm_studio_identifier_exists_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("identifier") && normalized.contains("already exists")
}

async fn best_loadable_lm_studio_context(
    model: &str,
    max_context: u64,
    desired_identifier: &str,
) -> Result<u64, String> {
    let step = context_search_step(max_context);
    let mut low = 1;
    let mut high = max_context.div_ceil(step);
    let mut best = None;
    let mut last_failure = None;

    while low <= high {
        let mid = low + (high - low) / 2;
        let context_length = (mid * step).min(max_context);
        match estimate_lm_studio_context_load(model, context_length, desired_identifier).await {
            Ok(estimate) if estimate.loadable => {
                best = Some(context_length);
                low = mid + 1;
            }
            Ok(estimate) => {
                last_failure = Some(estimate.detail);
                if mid == 0 {
                    break;
                }
                high = mid.saturating_sub(1);
            }
            Err(err) => return Err(err),
        }
    }

    best.ok_or_else(|| {
        last_failure.unwrap_or_else(|| {
            "LM Studio did not provide a loadable estimate for any context length.".to_string()
        })
    })
}

struct LmStudioLoadEstimate {
    loadable: bool,
    detail: String,
}

async fn estimate_lm_studio_context_load(
    model: &str,
    context_length: u64,
    desired_identifier: &str,
) -> Result<LmStudioLoadEstimate, String> {
    let mut command = lms_command()?;
    command
        .arg("load")
        .arg(model)
        .arg("--context-length")
        .arg(context_length.to_string())
        .arg("--identifier")
        .arg(desired_identifier)
        .arg("--estimate-only")
        .arg("--yes");
    let estimate = run_command(
        command,
        format!(
            "lms load {model} --context-length {context_length} --identifier {desired_identifier} --estimate-only --yes"
        ),
    )
    .await?;
    let detail = format!("{}\n{}", estimate.stdout, estimate.stderr);
    let normalized = detail.to_lowercase();
    Ok(LmStudioLoadEstimate {
        loadable: !normalized.contains("fail to load")
            && !normalized.contains("insufficient system resources"),
        detail: detail.trim().to_string(),
    })
}

fn context_search_step(max_context: u64) -> u64 {
    if max_context <= LM_STUDIO_CONTEXT_SEARCH_STEP {
        1
    } else {
        LM_STUDIO_CONTEXT_SEARCH_STEP
    }
}

fn load_context_fallbacks(best_context: u64) -> Vec<u64> {
    let step = context_search_step(best_context);
    let mut contexts = Vec::new();
    let mut current = best_context;
    while current > 0 && contexts.len() < 8 {
        contexts.push(current);
        if current <= step {
            break;
        }
        current -= step;
    }
    contexts
}

async fn unload_lm_studio_model_instances(
    model: &str,
) -> Result<DesktopLmStudioCommandResult, String> {
    let model = sanitize_model_arg(model)?;
    let loaded_instances = fetch_lms_ps_instances().await.unwrap_or_default();
    let unloaded = unload_matching_lm_studio_instances(&model, loaded_instances).await?;
    if unloaded.is_empty() {
        Ok(DesktopLmStudioCommandResult {
            command: format!("lms unload {model}"),
            status_code: Some(0),
            stdout: format!("No loaded LM Studio instances matched `{model}`."),
            stderr: String::new(),
        })
    } else {
        Ok(DesktopLmStudioCommandResult {
            command: format!("lms unload {}", unloaded.join(", ")),
            status_code: Some(0),
            stdout: format!("Unloaded {}.", unloaded.join(", ")),
            stderr: String::new(),
        })
    }
}

async fn unload_matching_lm_studio_instances(
    model: &str,
    loaded_instances: Vec<LmStudioLoadedModelInstance>,
) -> Result<Vec<String>, String> {
    let mut identifiers = loaded_instances
        .into_iter()
        .filter(|instance| lm_studio_model_ids_match(&instance.model_id, model))
        .map(|instance| instance.identifier)
        .filter(|identifier| is_safe_model_id(identifier))
        .collect::<Vec<_>>();
    identifiers.sort();
    identifiers.dedup();

    let mut unloaded = Vec::new();
    for identifier in identifiers {
        unload_lm_studio_identifier(&identifier).await?;
        unloaded.push(identifier);
    }
    Ok(unloaded)
}

async fn unload_lm_studio_identifier(identifier: &str) -> Result<(), String> {
    let identifier = sanitize_model_arg(identifier)?;
    let mut command = lms_command()?;
    command.arg("unload").arg(&identifier);
    run_command(command, format!("lms unload {identifier}"))
        .await
        .map(|_| ())
}

async fn wait_for_lm_studio_model_unloaded(
    model: &str,
    desired_identifier: &str,
) -> Result<(), String> {
    for _ in 0..LM_STUDIO_UNLOAD_POLL_ATTEMPTS {
        let instances = fetch_lms_ps_instances().await.unwrap_or_default();
        let still_loaded = instances.iter().any(|instance| {
            lm_studio_model_ids_match(&instance.model_id, model)
                || instance.identifier == desired_identifier
        });
        if !still_loaded {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(LM_STUDIO_UNLOAD_POLL_DELAY_MS)).await;
    }

    Err(format!(
        "LM Studio still reports `{desired_identifier}` as loaded after unload; wait a moment and try again."
    ))
}

async fn start_lm_studio_server(port: Option<u32>) -> Result<DesktopLmStudioCommandResult, String> {
    let mut command = lms_command()?;
    command.arg("server").arg("start");
    if let Some(port) = port {
        if port == 0 || port > u16::MAX as u32 {
            return Err("Port must be between 1 and 65535".to_string());
        }
        command.arg("--port").arg(port.to_string());
    }
    command.arg("--bind").arg("127.0.0.1");
    run_command(command, "lms server start".to_string()).await
}

async fn lm_studio_server_status() -> Result<DesktopLmStudioServerStatus, String> {
    let mut command = lms_command()?;
    command.arg("server").arg("status");
    let result = run_command(command, "lms server status".to_string()).await?;
    Ok(server_status_from_output(&result.stdout, &result.stderr))
}

fn server_status_from_output(stdout: &str, stderr: &str) -> DesktopLmStudioServerStatus {
    let detail = stdout.trim().to_string();
    let detail = if detail.is_empty() {
        stderr.trim().to_string()
    } else {
        detail
    };
    let normalized = detail.to_lowercase();

    DesktopLmStudioServerStatus {
        running: !normalized.contains("not running") && normalized.contains("running"),
        detail: if detail.is_empty() {
            "Unknown LM Studio server status.".to_string()
        } else {
            detail
        },
    }
}

fn lm_studio_models_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(&format!("{trimmed}/models"))
        .map_err(|_| "LM Studio endpoint is not a valid URL.".to_string())?;
    validate_lm_studio_local_url(url)
}

fn lm_studio_rest_models_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let mut url = reqwest::Url::parse(trimmed)
        .map_err(|_| "LM Studio endpoint is not a valid URL.".to_string())?;
    url.set_path("/api/v1/models");
    url.set_query(None);
    validate_lm_studio_local_url(url)
}

fn validate_lm_studio_local_url(url: reqwest::Url) -> Result<reqwest::Url, String> {
    let is_loopback = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            let host = host.trim_matches(|ch| ch == '[' || ch == ']');
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if is_loopback {
        Ok(url)
    } else {
        Err("LM Studio status checks only run against localhost endpoints.".to_string())
    }
}

async fn run_command(
    mut command: Command,
    display_command: String,
) -> Result<DesktopLmStudioCommandResult, String> {
    command
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb")
        .env("CI", "1");

    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|err| format!("Unable to join LM Studio command: {err}"))?
        .map_err(|err| format!("Unable to run `{display_command}`: {err}"))?;

    let result = DesktopLmStudioCommandResult {
        command: display_command.clone(),
        status_code: output.status.code(),
        stdout: clean_command_output(&String::from_utf8_lossy(&output.stdout)),
        stderr: clean_command_output(&String::from_utf8_lossy(&output.stderr)),
    };

    if output.status.success() {
        Ok(result)
    } else {
        let detail = if result.stderr.trim().is_empty() {
            result.stdout.trim()
        } else {
            result.stderr.trim()
        };
        Err(if detail.is_empty() {
            format!("`{display_command}` failed")
        } else {
            format!("`{display_command}` failed: {detail}")
        })
    }
}

fn parse_catalog_models(html: &str) -> Vec<DesktopLmStudioCatalogModel> {
    let mut models: Vec<DesktopLmStudioCatalogModel> = Vec::new();
    let mut rest = html;

    while let Some(href_index) = rest.find("href=\"/models/") {
        rest = &rest[href_index + "href=\"".len()..];
        let Some(href_end) = rest.find('"') else {
            break;
        };
        let href = &rest[..href_end];
        let id = href.trim_start_matches("/models/").trim_matches('/');
        if id.is_empty() || id.contains('/') || models.iter().any(|model| model.id == id) {
            rest = &rest[href_end..];
            continue;
        }

        let block = rest[..rest.find("</a>").unwrap_or(rest.len())].to_string();
        let name = extract_after(&block, "class=\"text-lg font-medium\">", "</div>")
            .map(|value| html_text(&value))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.to_string());
        let sizes = extract_model_sizes(&block);
        let updated = extract_updated(&block);

        models.push(DesktopLmStudioCatalogModel {
            id: id.to_string(),
            name,
            url: format!("https://lmstudio.ai{href}"),
            sizes,
            updated,
            variants: Vec::new(),
        });
        rest = &rest[href_end..];
    }

    models.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    models
}

fn parse_catalog_variants(html: &str) -> Vec<DesktopLmStudioCatalogVariant> {
    let mut variants: Vec<DesktopLmStudioCatalogVariant> = Vec::new();
    let mut rest = html;
    let href_marker = "href=\"/models/";

    while let Some(href_index) = rest.find(href_marker) {
        let candidate_start = href_index + "href=\"".len();
        rest = &rest[candidate_start..];
        let Some(href_end) = rest.find('"') else {
            break;
        };
        let href = &rest[..href_end];
        let id = href.trim_start_matches("/models/").trim_matches('/');
        if !id.contains('/') || variants.iter().any(|variant| variant.id == id) {
            rest = &rest[href_end..];
            continue;
        }

        let next_href = rest[href_end..]
            .find(href_marker)
            .map(|index| href_end + index)
            .unwrap_or(rest.len());
        let row = &rest[..next_href];
        let size = extract_after(row, "data-state=\"closed\">", "</div>")
            .map(|value| html_text(&value))
            .filter(|value| !value.is_empty());

        variants.push(DesktopLmStudioCatalogVariant {
            id: id.to_string(),
            name: id.to_string(),
            url: format!("https://lmstudio.ai{href}"),
            size,
        });
        rest = &rest[href_end..];
    }

    variants.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    variants
}

fn extract_after(value: &str, start: &str, end: &str) -> Option<String> {
    let start_index = value.find(start)? + start.len();
    let tail = &value[start_index..];
    let end_index = tail.find(end)?;
    Some(tail[..end_index].to_string())
}

fn extract_model_sizes(block: &str) -> Vec<String> {
    let mut sizes = Vec::new();
    let mut rest = block;
    let marker = "title=\"Model size: ";

    while let Some(index) = rest.find(marker) {
        rest = &rest[index + marker.len()..];
        let Some(end) = rest.find(" parameters") else {
            continue;
        };
        let size = html_text(&rest[..end]);
        if !size.is_empty() && !sizes.iter().any(|existing| existing == &size) {
            sizes.push(size);
        }
    }

    sizes
}

fn extract_updated(block: &str) -> Option<String> {
    let marker = "Updated <!-- -->";
    let start = block.find(marker)? + marker.len();
    let tail = &block[start..];
    let end = tail.find("</div>").unwrap_or(tail.len());
    let updated = html_text(&tail[..end]);
    (!updated.is_empty()).then(|| format!("Updated {updated}"))
}

fn html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split('<')
        .map(|part| part.split('>').next_back().unwrap_or(part))
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_installed_models(raw: &str) -> Result<Vec<DesktopLmStudioInstalledModel>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ls --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut models = Vec::new();
    collect_installed_models(&json, &mut models);

    let mut by_id: HashMap<String, DesktopLmStudioInstalledModel> = HashMap::new();
    for model in models {
        by_id.entry(model.id.clone()).or_insert(model);
    }
    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.to_lowercase().cmp(&right.id.to_lowercase()));
    Ok(models)
}

fn parse_model_ids(raw: &str) -> Result<Vec<String>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ps --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut ids = Vec::new();
    collect_model_ids(&json, &mut ids);
    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();
    Ok(ids)
}

fn parse_loaded_model_instances(raw: &str) -> Result<Vec<LmStudioLoadedModelInstance>, String> {
    let json = serde_json::from_str::<Value>(raw.trim()).map_err(|err| {
        format!("Unable to read `lms ps --json` output: {err}. Try updating LM Studio CLI.")
    })?;
    let mut instances = Vec::new();
    collect_loaded_model_instances(&json, &mut instances);
    instances.sort_by(|left, right| left.identifier.cmp(&right.identifier));
    instances.dedup_by(|left, right| left.identifier == right.identifier);
    Ok(instances)
}

fn collect_installed_models(value: &Value, models: &mut Vec<DesktopLmStudioInstalledModel>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_installed_models(item, models);
            }
        }
        Value::Object(object) => {
            if let Some(model) = installed_model_from_object(object) {
                models.push(model);
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_installed_models(value, models);
                }
            }
        }
        _ => {}
    }
}

fn collect_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            if is_lm_studio_chat_model_object(object) {
                if let Some(id) = string_field(
                    object,
                    &[
                        "modelKey",
                        "model_key",
                        "indexedModelIdentifier",
                        "path",
                        "key",
                        "id",
                        "model",
                        "identifier",
                    ],
                ) {
                    let id = canonical_lm_studio_model_id(id.trim());
                    if is_safe_model_id(&id)
                        && !is_lm_studio_embedding_model_id(&id)
                        && !ids.iter().any(|existing| existing == &id)
                    {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

fn collect_rest_loaded_llm_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_rest_loaded_llm_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            let has_loaded_instances = object
                .get("loaded_instances")
                .and_then(|value| value.as_array())
                .is_some_and(|instances| !instances.is_empty());
            if is_lm_studio_chat_model_object(object) && has_loaded_instances {
                if let Some(id) = string_field(
                    object,
                    &[
                        "key",
                        "modelKey",
                        "model_key",
                        "indexedModelIdentifier",
                        "path",
                        "id",
                        "model",
                    ],
                ) {
                    let id = canonical_lm_studio_model_id(id.trim());
                    if is_safe_model_id(&id)
                        && !is_lm_studio_embedding_model_id(&id)
                        && !ids.iter().any(|existing| existing == &id)
                    {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_rest_loaded_llm_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

fn collect_loaded_model_instances(value: &Value, instances: &mut Vec<LmStudioLoadedModelInstance>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_loaded_model_instances(item, instances);
            }
        }
        Value::Object(object) => {
            if let Some(instance) = loaded_model_instance_from_object(object) {
                instances.push(instance);
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_loaded_model_instances(value, instances);
                }
            }
        }
        _ => {}
    }
}

fn loaded_model_instance_from_object(
    object: &Map<String, Value>,
) -> Option<LmStudioLoadedModelInstance> {
    if !is_lm_studio_chat_model_object(object) {
        return None;
    }

    let model_id = string_field(
        object,
        &[
            "modelKey",
            "model_key",
            "indexedModelIdentifier",
            "path",
            "key",
            "model",
        ],
    )?;
    let identifier =
        string_field(object, &["identifier", "id"]).unwrap_or_else(|| model_id.clone());
    let model_id = lm_studio_model_match_key(&model_id);
    if !is_safe_model_id(&model_id) || !is_safe_model_id(&identifier) {
        return None;
    }

    Some(LmStudioLoadedModelInstance {
        model_id,
        identifier,
        context_length: context_length_field(object),
        max_context_length: max_context_length_field(object),
    })
}

fn model_max_context_length_from_value(value: &Value, model: &str) -> Option<u64> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| model_max_context_length_from_value(item, model))
            .max(),
        Value::Object(object) => {
            let current = object_matches_lm_studio_model(object, model)
                .then(|| max_context_length_field(object))
                .flatten();
            let nested = object
                .values()
                .filter(|value| matches!(value, Value::Array(_) | Value::Object(_)))
                .filter_map(|value| model_max_context_length_from_value(value, model))
                .max();
            current.or(nested)
        }
        _ => None,
    }
}

fn object_matches_lm_studio_model(object: &Map<String, Value>, model: &str) -> bool {
    if !is_lm_studio_chat_model_object(object) {
        return false;
    }

    for key in [
        "modelKey",
        "model_key",
        "indexedModelIdentifier",
        "path",
        "key",
        "id",
        "model",
        "identifier",
        "selectedVariant",
        "selected_variant",
    ] {
        if object
            .get(key)
            .and_then(|value| value.as_str())
            .is_some_and(|value| lm_studio_model_ids_match(value, model))
        {
            return true;
        }
    }

    object
        .get("variants")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .any(|value| lm_studio_model_ids_match(value, model))
}

fn installed_model_from_object(
    object: &Map<String, Value>,
) -> Option<DesktopLmStudioInstalledModel> {
    if !is_lm_studio_chat_model_object(object) {
        return None;
    }

    let id = string_field(
        object,
        &[
            "modelKey",
            "model_key",
            "key",
            "id",
            "identifier",
            "model",
            "name",
        ],
    )?;
    let id = id.trim();
    if !is_safe_model_id(id) {
        return None;
    }

    Some(DesktopLmStudioInstalledModel {
        id: id.to_string(),
        name: string_field(object, &["displayName", "display_name", "name", "label"])
            .unwrap_or_else(|| id.to_string()),
        size: size_field(object),
        path: string_field(
            object,
            &["path", "modelPath", "model_path", "filePath", "file_path"],
        ),
        architecture: string_field(
            object,
            &["architecture", "arch", "modelArchitecture", "type"],
        ),
    })
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        let value = value.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn is_lm_studio_chat_model_object(object: &Map<String, Value>) -> bool {
    object
        .get("type")
        .and_then(|value| value.as_str())
        .is_none_or(|kind| !kind.eq_ignore_ascii_case("embedding"))
}

fn is_lm_studio_embedding_model_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.contains("embedding")
        || lower.contains("embed-text")
        || lower.starts_with("text-embedding")
        || lower.starts_with("embed-")
        || lower.starts_with("nomic-embed")
}

fn u64_field(object: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
    })
}

fn context_length_field(object: &Map<String, Value>) -> Option<u64> {
    u64_field(object, &["contextLength", "context_length", "n_ctx"]).or_else(|| {
        object
            .get("config")?
            .as_object()
            .and_then(context_length_field)
    })
}

fn max_context_length_field(object: &Map<String, Value>) -> Option<u64> {
    u64_field(
        object,
        &[
            "maxContextLength",
            "max_context_length",
            "max_context",
            "maxContextTokens",
            "max_context_tokens",
        ],
    )
}

fn size_field(object: &Map<String, Value>) -> Option<String> {
    if let Some(value) = string_field(object, &["size", "fileSize", "file_size", "modelSize"]) {
        return Some(value);
    }

    [
        "sizeBytes",
        "size_bytes",
        "fileSizeBytes",
        "file_size_bytes",
    ]
    .iter()
    .find_map(|key| object.get(*key)?.as_u64())
    .map(format_bytes)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

fn canonical_lm_studio_model_id(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((base, suffix)) = trimmed.rsplit_once(':') {
        if base.contains('/') && suffix.chars().all(|ch| ch.is_ascii_digit()) {
            return base.to_string();
        }
    }
    trimmed.to_string()
}

fn lm_studio_model_match_key(value: &str) -> String {
    let canonical = canonical_lm_studio_model_id(value);
    canonical
        .split_once('@')
        .map(|(base, _)| base)
        .unwrap_or(canonical.as_str())
        .to_string()
}

fn lm_studio_model_ids_match(left: &str, right: &str) -> bool {
    lm_studio_model_match_key(left) == lm_studio_model_match_key(right)
}

fn is_safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 220
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '@'))
}

fn sanitize_model_arg(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a model before running this action.".to_string());
    }
    if trimmed.len() > 220 {
        return Err("Model id is too long.".to_string());
    }
    if !is_safe_model_id(trimmed) {
        return Err("Model ids can only contain letters, numbers, slash, colon, dot, dash, underscore, or @.".to_string());
    }
    Ok(trimmed.to_string())
}

fn clean_command_output(value: &str) -> String {
    let without_ansi = strip_ansi_sequences(value);
    let mut lines = Vec::new();
    let mut previous = String::new();

    for line in without_ansi.replace('\r', "\n").lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || is_terminal_cursor_sequence(trimmed)
            || is_spinner_status_line(trimmed)
            || trimmed == previous
        {
            continue;
        }
        previous = trimmed.to_string();
        lines.push(previous.clone());
    }

    truncate_output(&lines.join("\n"))
}

fn strip_ansi_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|next| *next == '[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
            continue;
        }
        output.push(ch);
    }

    output
}

fn is_terminal_cursor_sequence(value: &str) -> bool {
    matches!(value, "[?25l" | "[?25h" | "[2K" | "[1G")
}

fn is_spinner_status_line(value: &str) -> bool {
    let spinner_frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    value.starts_with("Loading ")
        && value
            .chars()
            .last()
            .is_some_and(|last| spinner_frames.contains(&last))
}

fn truncate_output(value: &str) -> String {
    if value.len() <= MAX_COMMAND_OUTPUT_BYTES {
        return value.to_string();
    }

    let mut end = MAX_COMMAND_OUTPUT_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… output truncated …", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_lm_studio_model_id, collect_rest_loaded_llm_model_ids, context_search_step,
        is_lm_studio_embedding_model_id, lm_studio_model_ids_match, lm_studio_models_endpoint,
        load_context_fallbacks, model_max_context_length_from_value, parse_installed_models,
        parse_loaded_model_instances, parse_model_ids, server_status_from_output,
    };
    use serde_json::json;

    #[test]
    fn lms_ps_parser_prefers_canonical_model_key_over_runtime_identifier() {
        let raw = r#"[
          {
            "modelKey": "google/gemma-4-e4b",
            "indexedModelIdentifier": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b:6",
            "selectedVariant": "google/gemma-4-e4b@q4_k_m"
          }
        ]"#;

        assert_eq!(parse_model_ids(raw).unwrap(), vec!["google/gemma-4-e4b"]);
    }

    #[test]
    fn embedding_models_are_excluded_from_chat_model_ids() {
        let raw = r#"[
          {
            "type": "llm",
            "modelKey": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b"
          },
          {
            "type": "embedding",
            "modelKey": "text-embedding-nomic-embed-text-v1.5",
            "identifier": "text-embedding-nomic-embed-text-v1.5"
          }
        ]"#;

        assert_eq!(parse_model_ids(raw).unwrap(), vec!["google/gemma-4-e4b"]);
        assert_eq!(parse_loaded_model_instances(raw).unwrap().len(), 1);
        assert_eq!(parse_installed_models(raw).unwrap().len(), 1);
        assert!(is_lm_studio_embedding_model_id(
            "text-embedding-nomic-embed-text-v1.5"
        ));
    }

    #[test]
    fn rest_loaded_model_parser_keeps_only_loaded_llms() {
        let json = json!({
            "models": [
                {
                    "type": "llm",
                    "key": "google/gemma-4-e4b",
                    "loaded_instances": [{"id": "google/gemma-4-e4b", "config": {"context_length": 131072}}]
                },
                {
                    "type": "embedding",
                    "key": "text-embedding-nomic-embed-text-v1.5",
                    "loaded_instances": [{"id": "text-embedding-nomic-embed-text-v1.5"}]
                },
                {
                    "type": "llm",
                    "key": "qwen/qwen3",
                    "loaded_instances": []
                }
            ]
        });
        let mut ids = Vec::new();
        collect_rest_loaded_llm_model_ids(&json, &mut ids);

        assert_eq!(ids, vec!["google/gemma-4-e4b"]);
    }

    #[test]
    fn lms_ps_parser_captures_context_lengths_for_reload_decisions() {
        let raw = r#"[
          {
            "modelKey": "google/gemma-4-e4b",
            "identifier": "google/gemma-4-e4b",
            "maxContextLength": 131072,
            "contextLength": 4096
          }
        ]"#;

        let instances = parse_loaded_model_instances(raw).unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].model_id, "google/gemma-4-e4b");
        assert_eq!(instances[0].identifier, "google/gemma-4-e4b");
        assert_eq!(instances[0].context_length, Some(4096));
        assert_eq!(instances[0].max_context_length, Some(131072));
    }

    #[test]
    fn installed_model_max_context_matches_base_and_variant_ids() {
        let json = json!([
            {
                "modelKey": "google/gemma-4-e4b",
                "selectedVariant": "google/gemma-4-e4b@q4_k_m",
                "maxContextLength": 131072
            }
        ]);

        assert_eq!(
            model_max_context_length_from_value(&json, "google/gemma-4-e4b"),
            Some(131072)
        );
        assert_eq!(
            model_max_context_length_from_value(&json, "google/gemma-4-e4b@q4_k_m"),
            Some(131072)
        );
    }

    #[test]
    fn context_search_uses_1024_token_steps_for_large_windows() {
        assert_eq!(context_search_step(131_072), 1024);
        assert_eq!(
            load_context_fallbacks(8192),
            vec![8192, 7168, 6144, 5120, 4096, 3072, 2048, 1024]
        );
    }

    #[test]
    fn lm_studio_model_matching_ignores_runtime_suffix_and_variant_suffix() {
        assert!(lm_studio_model_ids_match(
            "google/gemma-4-e4b:6",
            "google/gemma-4-e4b@q4_k_m"
        ));
    }

    #[test]
    fn canonical_lm_studio_model_id_strips_numeric_runtime_suffix() {
        assert_eq!(
            canonical_lm_studio_model_id("google/gemma-4-e4b:6"),
            "google/gemma-4-e4b"
        );
        assert_eq!(
            canonical_lm_studio_model_id("google/gemma-4-e4b@q4_k_m"),
            "google/gemma-4-e4b@q4_k_m"
        );
    }

    #[test]
    fn local_url_validation_rejects_lookalike_hosts() {
        assert!(lm_studio_models_endpoint("http://localhost:1234/v1").is_ok());
        assert!(lm_studio_models_endpoint("http://127.0.0.42:1234/v1").is_ok());
        assert!(lm_studio_models_endpoint("http://[::1]:1234/v1").is_ok());
        assert!(lm_studio_models_endpoint("file://localhost/v1").is_err());
        assert!(lm_studio_models_endpoint("http://localhost.evil.example/v1").is_err());
        assert!(lm_studio_models_endpoint("http://127.0.0.1.evil.example/v1").is_err());
    }

    #[test]
    fn server_status_reads_status_from_stderr_when_lms_uses_stderr() {
        let running = server_status_from_output("", "The server is running on port 1234.\n");
        assert!(running.running);
        assert_eq!(running.detail, "The server is running on port 1234.");

        let stopped = server_status_from_output("", "The server is not running.\n");
        assert!(!stopped.running);
        assert_eq!(stopped.detail, "The server is not running.");
    }
}
