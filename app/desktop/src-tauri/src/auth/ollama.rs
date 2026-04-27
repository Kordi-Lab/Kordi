use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Map, Value};

const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";
const OLLAMA_INSTALL_COMMAND: &str = "curl -fsSL https://ollama.com/install.sh | bash";
const OLLAMA_LIBRARY_URL: &str = "https://ollama.com/library";
const OLLAMA_SERVER_POLL_ATTEMPTS: usize = 20;
const OLLAMA_SERVER_POLL_DELAY_MS: u64 = 500;
const MAX_COMMAND_OUTPUT_BYTES: usize = 12_000;
const MAX_CATALOG_FAMILIES: usize = 120;
const MAX_CATALOG_VARIANTS: usize = 160;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaEnvironment {
    pub app_path: Option<String>,
    pub app_version: Option<String>,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub cli_source: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaServerStatus {
    pub running: bool,
    pub detail: String,
    pub version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaCommandResult {
    pub command: String,
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaCatalogVariant {
    pub id: String,
    pub name: String,
    pub url: String,
    pub size: Option<String>,
    pub context: Option<String>,
    pub input: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaCatalogModel {
    pub id: String,
    pub name: String,
    pub url: String,
    pub description: Option<String>,
    pub sizes: Vec<String>,
    pub pulls: Option<String>,
    pub tags: Option<String>,
    pub variants: Vec<DesktopOllamaCatalogVariant>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOllamaInstalledModel {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub modified_at: Option<String>,
}

#[tauri::command]
pub fn desktop_ollama_environment() -> DesktopOllamaEnvironment {
    ollama_environment()
}

#[tauri::command]
pub async fn desktop_ollama_server_status(
    base_url: String,
) -> Result<DesktopOllamaServerStatus, String> {
    ollama_server_status(&base_url).await
}

#[tauri::command]
pub async fn desktop_ollama_start_server(
    port: Option<u32>,
) -> Result<DesktopOllamaCommandResult, String> {
    start_ollama_server(port).await
}

#[tauri::command]
pub async fn desktop_ollama_open_app() -> Result<DesktopOllamaCommandResult, String> {
    open_ollama_app().await
}

#[tauri::command]
pub async fn desktop_ollama_install() -> Result<DesktopOllamaCommandResult, String> {
    if !cfg!(target_family = "unix") {
        return Err(
            "One-click Ollama install is currently supported on macOS and Linux.".to_string(),
        );
    }

    let mut command = Command::new("/bin/bash");
    command.arg("-lc").arg(OLLAMA_INSTALL_COMMAND);
    run_command(command, OLLAMA_INSTALL_COMMAND.to_string()).await
}

#[tauri::command]
pub async fn desktop_ollama_catalog_models() -> Result<Vec<DesktopOllamaCatalogModel>, String> {
    let html = reqwest::Client::new()
        .get(OLLAMA_LIBRARY_URL)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|err| format!("Unable to fetch Ollama library: {err}"))?
        .error_for_status()
        .map_err(|err| format!("Ollama library returned an error: {err}"))?
        .text()
        .await
        .map_err(|err| format!("Unable to read Ollama library: {err}"))?;
    Ok(parse_ollama_catalog_models(&html))
}

#[tauri::command]
pub async fn desktop_ollama_catalog_variants(
    model: String,
) -> Result<Vec<DesktopOllamaCatalogVariant>, String> {
    let model = sanitize_model_arg(&model)?;
    let family = model
        .split_once(':')
        .map(|(family, _)| family)
        .unwrap_or(&model);
    if is_embedding_model_id(family) {
        return Ok(Vec::new());
    }
    let url = format!("{OLLAMA_LIBRARY_URL}/{family}/tags");
    let html = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|err| format!("Unable to fetch Ollama tags for `{family}`: {err}"))?
        .error_for_status()
        .map_err(|err| format!("Ollama tags for `{family}` returned an error: {err}"))?
        .text()
        .await
        .map_err(|err| format!("Unable to read Ollama tags for `{family}`: {err}"))?;
    Ok(parse_ollama_catalog_variants(family, &html))
}

#[tauri::command]
pub async fn desktop_ollama_installed_models(
    base_url: String,
) -> Result<Vec<DesktopOllamaInstalledModel>, String> {
    installed_models_for_base_url(&base_url).await
}

#[tauri::command]
pub async fn desktop_ollama_running_model_ids(base_url: String) -> Result<Vec<String>, String> {
    running_model_ids_for_base_url(&base_url).await
}

#[tauri::command]
pub async fn desktop_ollama_pull_model(
    base_url: String,
    model: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let model = sanitize_chat_model_arg(&model)?;
    ensure_server_running(port_from_base_url(&base_url)).await?;
    post_ollama_json_command(
        &base_url,
        "/api/pull",
        json!({ "model": model, "stream": false }),
        format!("POST /api/pull {model}"),
    )
    .await
}

#[tauri::command]
pub async fn desktop_ollama_load_model(
    base_url: String,
    model: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let model = sanitize_chat_model_arg(&model)?;
    ensure_server_running(port_from_base_url(&base_url)).await?;
    post_ollama_json_command(
        &base_url,
        "/api/generate",
        json!({ "model": model, "prompt": "", "stream": false, "keep_alive": "30m" }),
        format!("POST /api/generate load {model}"),
    )
    .await
}

#[tauri::command]
pub async fn desktop_ollama_stop_model(
    base_url: String,
    model: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let model = sanitize_chat_model_arg(&model)?;
    post_ollama_json_command(
        &base_url,
        "/api/generate",
        json!({ "model": model, "prompt": "", "stream": false, "keep_alive": 0 }),
        format!("POST /api/generate stop {model}"),
    )
    .await
}

#[tauri::command]
pub async fn desktop_ollama_delete_model(
    base_url: String,
    model: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let model = sanitize_chat_model_arg(&model)?;
    post_ollama_delete_command(
        &base_url,
        json!({ "model": model }),
        format!("DELETE /api/delete {model}"),
    )
    .await
}

pub async fn ensure_server_running(port: Option<u32>) -> Result<(), String> {
    let base_url = base_url_for_port(port.unwrap_or(11434))?;
    if ollama_server_status(&base_url)
        .await
        .is_ok_and(|status| status.running)
    {
        return Ok(());
    }

    start_ollama_server(port).await?;
    for _ in 0..OLLAMA_SERVER_POLL_ATTEMPTS {
        if ollama_server_status(&base_url)
            .await
            .is_ok_and(|status| status.running)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(OLLAMA_SERVER_POLL_DELAY_MS)).await;
    }

    Err("Ollama did not report as running after start.".to_string())
}

pub async fn running_model_ids_for_base_url(base_url: &str) -> Result<Vec<String>, String> {
    let url = ollama_api_endpoint(base_url, "/api/ps")?;
    let json = get_ollama_json(url, "Ollama running model list").await?;
    let mut ids = Vec::new();
    collect_ollama_model_ids(&json, &mut ids);
    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();
    Ok(ids)
}

async fn installed_models_for_base_url(
    base_url: &str,
) -> Result<Vec<DesktopOllamaInstalledModel>, String> {
    let url = ollama_api_endpoint(base_url, "/api/tags")?;
    let json = get_ollama_json(url, "Ollama installed model list").await?;
    let mut models = Vec::new();
    collect_installed_models(&json, &mut models);
    models.sort_by_key(|model| model.id.to_lowercase());
    models.dedup_by(|left, right| left.id == right.id);
    Ok(models)
}

async fn ollama_server_status(base_url: &str) -> Result<DesktopOllamaServerStatus, String> {
    let url = ollama_api_endpoint(base_url, "/api/version")?;
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|err| format!("Unable to contact Ollama: {err}"))?;
    if !response.status().is_success() {
        return Ok(DesktopOllamaServerStatus {
            running: false,
            detail: format!("Ollama returned HTTP {}.", response.status()),
            version: None,
        });
    }
    let json = response
        .json::<Value>()
        .await
        .map_err(|err| format!("Unable to read Ollama version response: {err}"))?;
    let version = json
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    Ok(DesktopOllamaServerStatus {
        running: true,
        detail: version
            .as_ref()
            .map(|version| format!("Ollama is running ({version})."))
            .unwrap_or_else(|| "Ollama is running.".to_string()),
        version,
    })
}

async fn start_ollama_server(port: Option<u32>) -> Result<DesktopOllamaCommandResult, String> {
    let port = port.unwrap_or(11434);
    if port == 0 || port > u16::MAX as u32 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    let base_url = base_url_for_port(port)?;
    if ollama_server_status(&base_url)
        .await
        .is_ok_and(|status| status.running)
    {
        return Ok(DesktopOllamaCommandResult {
            command: "GET /api/version".to_string(),
            status_code: Some(0),
            stdout: "Ollama is already running.".to_string(),
            stderr: String::new(),
        });
    }

    if port != 11434 {
        return spawn_ollama_serve(port).await;
    }

    if let Some(app_path) = find_ollama_app_path() {
        let mut command = Command::new("open");
        command.arg(&app_path);
        return run_command(command, format!("open {}", app_path.display())).await;
    }

    spawn_ollama_serve(port).await
}

async fn open_ollama_app() -> Result<DesktopOllamaCommandResult, String> {
    if let Some(app_path) = find_ollama_app_path() {
        let mut command = Command::new("open");
        command.arg(&app_path);
        return run_command(command, format!("open {}", app_path.display())).await;
    }

    run_command(
        open_url_command(OLLAMA_DOWNLOAD_URL),
        format!("open {OLLAMA_DOWNLOAD_URL}"),
    )
    .await
}

fn open_url_command(url: &str) -> Command {
    if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        return command;
    }
    if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        return command;
    }
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}

async fn spawn_ollama_serve(port: u32) -> Result<DesktopOllamaCommandResult, String> {
    let resolved = resolve_ollama_path()
        .ok_or_else(|| "Ollama CLI was not found. Install Ollama first.".to_string())?;
    let host = format!("127.0.0.1:{port}");
    let path = resolved.path;
    let display = format!("OLLAMA_HOST={host} ollama serve");
    let pid = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&path)
            .arg("serve")
            .env("OLLAMA_HOST", &host)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|child| child.id())
    })
    .await
    .map_err(|err| format!("Unable to join Ollama server start: {err}"))?
    .map_err(|err| format!("Unable to start `ollama serve`: {err}"))?;

    Ok(DesktopOllamaCommandResult {
        command: display,
        status_code: Some(0),
        stdout: format!("Started Ollama server process {pid}."),
        stderr: String::new(),
    })
}

async fn get_ollama_json(url: Url, label: &str) -> Result<Value, String> {
    reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|err| format!("Unable to contact {label}: {err}"))?
        .error_for_status()
        .map_err(|err| format!("{label} returned an error: {err}"))?
        .json::<Value>()
        .await
        .map_err(|err| format!("Unable to read {label}: {err}"))
}

async fn post_ollama_json_command(
    base_url: &str,
    path: &str,
    body: Value,
    display_command: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let url = ollama_api_endpoint(base_url, path)?;
    let response = reqwest::Client::new()
        .post(url)
        .json(&body)
        .timeout(Duration::from_secs(60 * 20))
        .send()
        .await
        .map_err(|err| format!("Unable to run `{display_command}`: {err}"))?;
    response_to_command_result(response, display_command).await
}

async fn post_ollama_delete_command(
    base_url: &str,
    body: Value,
    display_command: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let url = ollama_api_endpoint(base_url, "/api/delete")?;
    let response = reqwest::Client::new()
        .delete(url)
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|err| format!("Unable to run `{display_command}`: {err}"))?;
    response_to_command_result(response, display_command).await
}

async fn response_to_command_result(
    response: reqwest::Response,
    display_command: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Unable to read `{display_command}` response: {err}"))?;
    let output = clean_command_output(&text);
    let result = DesktopOllamaCommandResult {
        command: display_command.clone(),
        status_code: Some(i32::from(status.as_u16())),
        stdout: output,
        stderr: String::new(),
    };
    if status.is_success() {
        Ok(result)
    } else {
        Err(format!("`{display_command}` failed: {}", result.stdout))
    }
}

fn ollama_environment() -> DesktopOllamaEnvironment {
    let app_path = find_ollama_app_path();
    let app_version = app_path.as_deref().and_then(app_version);
    let resolved = resolve_ollama_path();
    let cli_version = resolved
        .as_ref()
        .and_then(|resolved| ollama_version(&resolved.path));
    let mut notes = Vec::new();

    if app_path.is_none() {
        notes.push("Ollama.app was not found in /Applications or ~/Applications.".to_string());
    }
    if resolved.is_none() {
        notes.push(
            "The `ollama` CLI was not found. Install Ollama or open the app once.".to_string(),
        );
    }

    DesktopOllamaEnvironment {
        app_path: app_path.map(path_to_string),
        app_version,
        cli_path: resolved
            .as_ref()
            .map(|resolved| path_to_string(resolved.path.clone())),
        cli_version,
        cli_source: resolved.map(|resolved| resolved.source),
        notes,
    }
}

struct ResolvedOllamaPath {
    path: PathBuf,
    source: String,
}

fn resolve_ollama_path() -> Option<ResolvedOllamaPath> {
    let mut candidates = Vec::new();
    if let Some(path) = shell_command_path("ollama") {
        candidates.push((path, "shell PATH".to_string()));
    }
    if let Some(app_path) = find_ollama_app_path() {
        candidates.push((
            app_path.join("Contents").join("Resources").join("ollama"),
            "Ollama.app".to_string(),
        ));
        candidates.push((
            app_path.join("Contents").join("MacOS").join("Ollama"),
            "Ollama.app".to_string(),
        ));
    }
    for path in [
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
        "/bin/ollama",
    ] {
        candidates.push((PathBuf::from(path), path.to_string()));
    }

    candidates
        .into_iter()
        .find(|(path, _)| path.exists())
        .map(|(path, source)| ResolvedOllamaPath { path, source })
}

fn find_ollama_app_path() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications/Ollama.app")];
    if let Some(home) = home_dir() {
        candidates.push(home.join("Applications").join("Ollama.app"));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn app_version(path: &Path) -> Option<String> {
    let info_plist = path.join("Contents").join("Info.plist");
    let contents = fs::read_to_string(info_plist).ok()?;
    plist_string_value(&contents, "CFBundleShortVersionString")
        .or_else(|| plist_string_value(&contents, "CFBundleVersion"))
}

fn plist_string_value(contents: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let tail = contents.split_once(&marker)?.1;
    let start = tail.find("<string>")? + "<string>".len();
    let rest = &tail[start..];
    let end = rest.find("</string>")?;
    let value = html_text(&rest[..end]);
    (!value.is_empty()).then_some(value)
}

fn ollama_version(path: &Path) -> Option<String> {
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
        let output = Command::new(shell).arg("-lc").arg(&script).output().ok()?;
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

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn base_url_for_port(port: u32) -> Result<String, String> {
    if port == 0 || port > u16::MAX as u32 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    Ok(format!("http://localhost:{port}/v1"))
}

fn port_from_base_url(base_url: &str) -> Option<u32> {
    Url::parse(base_url).ok()?.port().map(u32::from)
}

fn ollama_api_endpoint(base_url: &str, path: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url.trim().trim_end_matches('/'))
        .map_err(|_| "Ollama endpoint is not a valid URL.".to_string())?;
    validate_ollama_local_url(&url)?;
    url.set_path(path);
    url.set_query(None);
    Ok(url)
}

fn validate_ollama_local_url(url: &Url) -> Result<(), String> {
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => Ok(()),
        Some(host) if host.starts_with("127.") => Ok(()),
        _ => Err("Ollama controls only run against localhost endpoints.".to_string()),
    }
}

fn collect_ollama_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_ollama_model_ids(item, ids);
            }
        }
        Value::Object(object) => {
            if is_ollama_chat_model_object(object) {
                if let Some(id) = string_field(object, &["model", "name", "id"]) {
                    let id = canonical_ollama_model_id(&id);
                    if is_safe_model_id(&id) && !ids.iter().any(|existing| existing == &id) {
                        ids.push(id);
                    }
                }
            }
            for value in object.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_ollama_model_ids(value, ids);
                }
            }
        }
        _ => {}
    }
}

fn collect_installed_models(value: &Value, models: &mut Vec<DesktopOllamaInstalledModel>) {
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

fn installed_model_from_object(object: &Map<String, Value>) -> Option<DesktopOllamaInstalledModel> {
    if !is_ollama_chat_model_object(object) {
        return None;
    }
    let id =
        string_field(object, &["model", "name", "id"]).map(|id| canonical_ollama_model_id(&id))?;
    if !is_safe_model_id(&id) {
        return None;
    }
    let details = object.get("details").and_then(|value| value.as_object());
    Some(DesktopOllamaInstalledModel {
        name: id.clone(),
        id,
        size: size_field(object),
        family: details.and_then(|details| string_field(details, &["family"])),
        parameter_size: details.and_then(|details| string_field(details, &["parameter_size"])),
        quantization: details.and_then(|details| string_field(details, &["quantization_level"])),
        modified_at: string_field(object, &["modified_at"]),
    })
}

fn is_ollama_chat_model_object(object: &Map<String, Value>) -> bool {
    let id = string_field(object, &["model", "name", "id"]).unwrap_or_default();
    if is_embedding_model_id(&id) {
        return false;
    }

    let Some(details) = object.get("details").and_then(|value| value.as_object()) else {
        return true;
    };
    if string_field(details, &["family"])
        .as_deref()
        .is_some_and(is_embedding_family)
    {
        return false;
    }
    details
        .get("families")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .all(|family| !is_embedding_family(family))
}

fn is_embedding_family(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.contains("embed") || lower.contains("embedding") || lower == "bert"
}

fn is_embedding_model_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    let model_part = lower
        .rsplit_once('/')
        .map(|(_, suffix)| suffix)
        .unwrap_or(&lower);
    model_part.contains("embedding")
        || model_part.contains("embed-text")
        || model_part.contains("-embed")
        || model_part.starts_with("text-embedding")
        || model_part.starts_with("embed-")
        || model_part.starts_with("nomic-embed")
        || model_part.starts_with("mxbai-embed")
        || model_part.starts_with("all-minilm")
        || model_part.starts_with("bge-")
        || model_part.starts_with("bge_")
        || model_part.starts_with("paraphrase-")
        || model_part.starts_with("snowflake-arctic-embed")
}

fn sanitize_chat_model_arg(value: &str) -> Result<String, String> {
    let model = sanitize_model_arg(value)?;
    if is_embedding_model_id(&model) {
        return Err(format!(
            "`{model}` is an embedding model and cannot be used for chat. Choose a chat model instead."
        ));
    }
    Ok(model)
}

fn sanitize_model_arg(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a model before running this action.".to_string());
    }
    if !is_safe_model_id(trimmed) {
        return Err(
            "Model names may only contain letters, numbers, '.', '-', '_', '/', and ':'."
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn is_safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 220
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':'))
}

fn canonical_ollama_model_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:latest")
    }
}

fn parse_ollama_catalog_models(html: &str) -> Vec<DesktopOllamaCatalogModel> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for block in html.split("<li x-test-model").skip(1) {
        let block = block
            .split_once("</li>")
            .map(|(item, _)| item)
            .unwrap_or(block);
        let Some(href) = attr_after(block, "href=\"/library/") else {
            continue;
        };
        let id = href
            .split(['\"', '?', '#'])
            .next()
            .unwrap_or_default()
            .trim();
        if id.is_empty()
            || id.contains(':')
            || is_embedding_model_id(id)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        let title = attr_after(block, "title=\"")
            .and_then(|value| value.split('\"').next().map(html_text))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| id.to_string());
        let description = first_paragraph_text(block);
        let sizes = collect_badge_values(block, "x-test-size");
        let pulls = test_value(block, "x-test-pull-count");
        let tags = test_value(block, "x-test-tag-count");
        models.push(DesktopOllamaCatalogModel {
            id: id.to_string(),
            name: title,
            url: format!("{OLLAMA_LIBRARY_URL}/{id}"),
            description,
            sizes,
            pulls,
            tags,
            variants: Vec::new(),
        });
        if models.len() >= MAX_CATALOG_FAMILIES {
            break;
        }
    }
    models
}

fn parse_ollama_catalog_variants(family: &str, html: &str) -> Vec<DesktopOllamaCatalogVariant> {
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    let marker = "<input class=\"command hidden\" value=\"";
    for part in html.split(marker).skip(1) {
        let Some(id) = part.split('\"').next().map(str::trim) else {
            continue;
        };
        if id.is_empty()
            || !id.starts_with(family)
            || is_embedding_model_id(id)
            || !is_safe_model_id(id)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        let row = part.split(marker).next().unwrap_or(part);
        let text = html_text(row);
        variants.push(DesktopOllamaCatalogVariant {
            id: id.to_string(),
            name: id.to_string(),
            url: format!("{OLLAMA_LIBRARY_URL}/{id}"),
            size: first_size_text(&text),
            context: first_context_text(&text),
            input: first_input_text(&text),
        });
        if variants.len() >= MAX_CATALOG_VARIANTS {
            break;
        }
    }
    variants
}

fn attr_after<'a>(value: &'a str, marker: &str) -> Option<&'a str> {
    value.split_once(marker).map(|(_, tail)| tail)
}

fn first_paragraph_text(block: &str) -> Option<String> {
    let tail = block.split_once("<p")?.1;
    let content = tail.split_once('>')?.1;
    let value = html_text(
        content
            .split_once("</p>")
            .map(|(text, _)| text)
            .unwrap_or(content),
    );
    (!value.is_empty()).then_some(value)
}

fn collect_badge_values(block: &str, marker: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    for part in block.split(marker).skip(1) {
        let Some(content) = part.split_once('>').map(|(_, tail)| tail) else {
            continue;
        };
        let value = html_text(
            content
                .split_once('<')
                .map(|(text, _)| text)
                .unwrap_or(content),
        );
        if !value.is_empty() && seen.insert(value.clone()) {
            values.push(value);
        }
    }
    values
}

fn test_value(block: &str, marker: &str) -> Option<String> {
    let content = block.split_once(marker)?.1.split_once('>')?.1;
    let value = html_text(
        content
            .split_once('<')
            .map(|(text, _)| text)
            .unwrap_or(content),
    );
    (!value.is_empty()).then_some(value)
}

fn first_size_text(value: &str) -> Option<String> {
    first_token_with_suffix(value, &["GB", "MB", "KB"])
}

fn first_context_text(value: &str) -> Option<String> {
    value.split('•').find_map(|part| {
        let cleaned = part.trim();
        cleaned
            .to_ascii_lowercase()
            .contains("context")
            .then(|| cleaned.to_string())
    })
}

fn first_input_text(value: &str) -> Option<String> {
    value.split('•').find_map(|part| {
        let cleaned = part.trim();
        cleaned
            .to_ascii_lowercase()
            .contains("input")
            .then(|| cleaned.to_string())
    })
}

fn first_token_with_suffix(value: &str, suffixes: &[&str]) -> Option<String> {
    let tokens = value.split_whitespace().collect::<Vec<_>>();
    for token in &tokens {
        for suffix in suffixes {
            if token.len() > suffix.len() && token.to_ascii_uppercase().ends_with(suffix) {
                let number = &token[..token.len() - suffix.len()];
                if number.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
                    return Some(format!("{number}{suffix}"));
                }
            }
        }
    }
    for pair in tokens.windows(2) {
        if suffixes
            .iter()
            .any(|suffix| pair[1].eq_ignore_ascii_case(suffix))
            && pair[0].chars().all(|ch| ch.is_ascii_digit() || ch == '.')
        {
            return Some(format!("{}{}", pair[0], pair[1]));
        }
    }
    None
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        let value = value.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn size_field(object: &Map<String, Value>) -> Option<String> {
    if let Some(value) = string_field(object, &["size", "fileSize", "file_size", "modelSize"]) {
        return Some(value);
    }
    [
        "size",
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

async fn run_command(
    mut command: Command,
    display_command: String,
) -> Result<DesktopOllamaCommandResult, String> {
    command
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb")
        .env("CI", "1");

    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|err| format!("Unable to join Ollama command: {err}"))?
        .map_err(|err| format!("Unable to run `{display_command}`: {err}"))?;

    let result = DesktopOllamaCommandResult {
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

fn clean_command_output(value: &str) -> String {
    let without_ansi = strip_ansi_sequences(value);
    let lines = without_ansi
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !is_spinner_status_line(line.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    truncate_output(lines.trim())
}

fn strip_ansi_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            while let Some(next) = chars.next() {
                if next.is_ascii_alphabetic() || next == 'm' {
                    break;
                }
            }
            continue;
        }
        if ch == '\r' {
            output.push('\n');
            continue;
        }
        if ch.is_control() && ch != '\n' && ch != '\t' {
            continue;
        }
        output.push(ch);
    }
    output
}

fn is_spinner_status_line(value: &str) -> bool {
    let spinner_frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    value
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

fn html_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;
    let mut entity = String::new();
    let mut in_entity = false;

    for ch in value.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
                output.push(' ');
            }
            continue;
        }
        if ch == '<' {
            in_tag = true;
            output.push(' ');
            continue;
        }
        if in_entity {
            if ch == ';' {
                output.push(match entity.as_str() {
                    "amp" => '&',
                    "quot" => '"',
                    "#39" | "apos" => '\'',
                    "lt" => '<',
                    "gt" => '>',
                    "nbsp" => ' ',
                    _ => ' ',
                });
                entity.clear();
                in_entity = false;
            } else if entity.len() < 12 {
                entity.push(ch);
            } else {
                entity.clear();
                in_entity = false;
            }
            continue;
        }
        if ch == '&' {
            in_entity = true;
            entity.clear();
            continue;
        }
        output.push(ch);
    }

    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ollama_api_endpoint_rewrites_openai_base_to_native_api_path() {
        let url = ollama_api_endpoint("http://localhost:11434/v1", "/api/tags").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/tags");
    }

    #[test]
    fn installed_model_parser_excludes_embedding_models() {
        let value = json!({
            "models": [
                {"name": "llama3.2:latest", "model": "llama3.2:latest", "size": 2019393189, "details": {"family": "llama"}},
                {"name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest", "size": 274000000, "details": {"family": "bert"}}
            ]
        });
        let mut models = Vec::new();
        collect_installed_models(&value, &mut models);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "llama3.2:latest");
    }

    #[test]
    fn running_model_parser_canonicalizes_and_excludes_embeddings() {
        let value = json!({
            "models": [
                {"name": "gemma3", "model": "gemma3", "details": {"family": "gemma"}},
                {"name": "all-minilm:latest", "model": "all-minilm:latest", "details": {"family": "bert"}}
            ]
        });
        let mut ids = Vec::new();
        collect_ollama_model_ids(&value, &mut ids);
        assert_eq!(ids, vec!["gemma3:latest"]);
    }

    #[test]
    fn catalog_parser_skips_embedding_families() {
        let html = r#"
          <li x-test-model><a href="/library/llama3.2"><div x-test-model-title title="llama3.2"><p>Small model.</p><span x-test-size>3b</span></div><span x-test-pull-count>1M</span><span x-test-tag-count>8</span></a></li>
          <li x-test-model><a href="/library/nomic-embed-text"><div x-test-model-title title="nomic-embed-text"><p>Embedding model.</p></div></a></li>
        "#;
        let models = parse_ollama_catalog_models(html);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "llama3.2");
        assert_eq!(models[0].sizes, vec!["3b"]);
    }

    #[test]
    fn tag_parser_extracts_exact_variants() {
        let html = r#"
          <input class="command hidden" value="llama3.2:latest" />
          <p>2.0GB · 128K context window · Text input · 1 year ago</p>
          <input class="command hidden" value="llama3.2:3b" />
          <p>2.0GB · 128K context window · Text input · 1 year ago</p>
        "#;
        let variants = parse_ollama_catalog_variants("llama3.2", html);
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].id, "llama3.2:latest");
        assert_eq!(variants[0].size.as_deref(), Some("2.0GB"));
    }
}
