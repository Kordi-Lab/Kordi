use std::{process::Command, time::Duration};

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;

mod environment;
mod parsing;

use environment::{
    add_lm_studio_bin_to_shell_path, find_lm_studio_app_path, find_lm_studio_bin_dir,
    lm_studio_environment, lms_command,
};
use parsing::{
    canonical_lm_studio_model_id, collect_rest_loaded_llm_model_ids,
    is_lm_studio_embedding_model_id, is_safe_model_id, lm_studio_model_match_key,
    model_max_context_length_from_value, parse_catalog_models, parse_catalog_variants,
    parse_installed_models, parse_loaded_model_instances, parse_model_ids, sanitize_model_arg,
    LmStudioLoadedModelInstance,
};

pub(crate) fn lm_studio_model_ids_match(left: &str, right: &str) -> bool {
    parsing::lm_studio_model_ids_match(left, right)
}

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
        Err(friendly_lms_command_failure(&display_command, detail))
    }
}

fn lms_output_mentions_invalid_passkey(value: &str) -> bool {
    let normalized = value.to_lowercase();
    normalized.contains("invalid passkey")
        || (normalized.contains("failed to authenticate") && normalized.contains("lms cli client"))
}

fn friendly_lms_command_failure(display_command: &str, detail: &str) -> String {
    if detail.trim().is_empty() {
        return format!("`{display_command}` failed");
    }

    if lms_output_mentions_invalid_passkey(detail) {
        return format!(
            "LM Studio rejected the lms CLI passkey while running `{display_command}`. \
This usually means the running LM Studio app and the lms CLI/key on disk are out of sync. \
Quit LM Studio completely. Open LM Studio again, then in Kordi open Authentication → LM Studio and click Check setup / Refresh installed. \
If it still fails, update LM Studio and click Add lms to PATH so Kordi uses LM Studio's bundled CLI.\n\nOriginal lms output:\n{detail}"
        );
    }

    format!("`{display_command}` failed: {detail}")
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
        context_search_step, friendly_lms_command_failure, lm_studio_models_endpoint,
        load_context_fallbacks, server_status_from_output,
    };

    #[test]
    fn context_search_uses_1024_token_steps_for_large_windows() {
        assert_eq!(context_search_step(131_072), 1024);
        assert_eq!(
            load_context_fallbacks(8192),
            vec![8192, 7168, 6144, 5120, 4096, 3072, 2048, 1024]
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

    #[test]
    fn lms_passkey_failure_is_reported_with_recovery_steps() {
        let raw = "[LMStudioClient][Repository][ClientPort][WsClientTransport:AuthenticatedWsClientTransport] WebSocket error: Error: Failed to authenticate: Invalid passkey for lms CLI client. Please make sure you are using the lms shipped with LM Studio.\nError: WebSocket connection closed";
        let message = friendly_lms_command_failure("lms ls --json", raw);

        assert!(message.contains("LM Studio rejected the lms CLI passkey"));
        assert!(message.contains("Quit LM Studio completely"));
        assert!(message.contains("Open LM Studio again"));
        assert!(message.contains("Add lms to PATH"));
        assert!(message.contains("Original lms output"));
    }

    #[test]
    fn lms_non_passkey_failure_keeps_command_context() {
        let message = friendly_lms_command_failure("lms ls --json", "boom");
        assert_eq!(message, "`lms ls --json` failed: boom");
    }
}
