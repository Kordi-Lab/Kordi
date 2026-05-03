use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};

mod parsing;

use parsing::{
    canonical_ollama_model_id, collect_installed_models, collect_ollama_model_ids,
    filter_running_model_ids_to_installed, html_text, is_embedding_model_id,
    parse_ollama_catalog_models, parse_ollama_catalog_variants, sanitize_chat_model_arg,
    sanitize_model_arg,
};

const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";
const OLLAMA_INSTALL_COMMAND: &str = "curl -fsSL https://ollama.com/install.sh | bash";
const OLLAMA_LIBRARY_URL: &str = "https://ollama.com/library";
const OLLAMA_SERVER_POLL_ATTEMPTS: usize = 20;
const OLLAMA_SERVER_POLL_DELAY_MS: u64 = 500;
const MAX_COMMAND_OUTPUT_BYTES: usize = 12_000;

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
    stop_ollama_model_command(&base_url, &model).await
}

#[tauri::command]
pub async fn desktop_ollama_delete_model(
    base_url: String,
    model: String,
) -> Result<DesktopOllamaCommandResult, String> {
    let model = sanitize_chat_model_arg(&model)?;
    ensure_server_running(port_from_base_url(&base_url)).await?;
    let stop_result = stop_ollama_model_if_running(&base_url, &model).await?;
    let delete_result = delete_ollama_model_command(&base_url, &model).await?;
    Ok(combine_stop_delete_result(
        &model,
        stop_result.as_ref(),
        &delete_result,
    ))
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
    let installed_models = installed_models_for_base_url(base_url).await?;
    Ok(filter_running_model_ids_to_installed(
        ids,
        &installed_models,
    ))
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

async fn stop_ollama_model_command(
    base_url: &str,
    model: &str,
) -> Result<DesktopOllamaCommandResult, String> {
    post_ollama_json_command(
        base_url,
        "/api/generate",
        json!({ "model": model, "prompt": "", "stream": false, "keep_alive": 0 }),
        format!("POST /api/generate stop {model}"),
    )
    .await
}

async fn stop_ollama_model_if_running(
    base_url: &str,
    model: &str,
) -> Result<Option<DesktopOllamaCommandResult>, String> {
    let target = canonical_ollama_model_id(model);
    let running_ids = running_model_ids_for_base_url(base_url).await?;
    if !running_ids
        .iter()
        .any(|id| canonical_ollama_model_id(id) == target)
    {
        return Ok(None);
    }

    stop_ollama_model_command(base_url, model).await.map(Some)
}

async fn delete_ollama_model_command(
    base_url: &str,
    model: &str,
) -> Result<DesktopOllamaCommandResult, String> {
    post_ollama_delete_command(
        base_url,
        json!({ "model": model }),
        format!("DELETE /api/delete {model}"),
    )
    .await
}

fn combine_stop_delete_result(
    model: &str,
    stop_result: Option<&DesktopOllamaCommandResult>,
    delete_result: &DesktopOllamaCommandResult,
) -> DesktopOllamaCommandResult {
    let command = stop_result
        .map(|result| format!("{} && {}", result.command, delete_result.command))
        .unwrap_or_else(|| delete_result.command.clone());
    let mut stderr = Vec::new();
    if let Some(result) = stop_result {
        if !result.stderr.trim().is_empty() {
            stderr.push(result.stderr.trim().to_string());
        }
    }
    if !delete_result.stderr.trim().is_empty() {
        stderr.push(delete_result.stderr.trim().to_string());
    }

    DesktopOllamaCommandResult {
        command,
        status_code: delete_result.status_code,
        stdout: if stop_result.is_some() {
            format!("Stopped running copy of {model}.\nDeleted {model} from Ollama.")
        } else {
            format!("Deleted {model} from Ollama.")
        },
        stderr: stderr.join("\n"),
    }
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
    let is_loopback = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            let host = host.trim_matches(|ch| ch == '[' || ch == ']');
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if is_loopback {
        Ok(())
    } else {
        Err("Ollama controls only run against localhost endpoints.".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ollama_api_endpoint_rewrites_openai_base_to_native_api_path() {
        let url = ollama_api_endpoint("http://localhost:11434/v1", "/api/tags").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/tags");
    }

    #[test]
    fn local_url_validation_rejects_lookalike_hosts() {
        assert!(ollama_api_endpoint("http://localhost:11434/v1", "/api/tags").is_ok());
        assert!(ollama_api_endpoint("http://127.0.0.42:11434/v1", "/api/tags").is_ok());
        assert!(ollama_api_endpoint("http://[::1]:11434/v1", "/api/tags").is_ok());
        assert!(ollama_api_endpoint("file://localhost/v1", "/api/tags").is_err());
        assert!(ollama_api_endpoint("http://localhost.evil.example/v1", "/api/tags").is_err());
        assert!(ollama_api_endpoint("http://127.0.0.1.evil.example/v1", "/api/tags").is_err());
    }

    #[test]
    fn stop_delete_result_reports_both_runtime_and_disk_cleanup() {
        let stop_result = DesktopOllamaCommandResult {
            command: "POST /api/generate stop qwen3:latest".to_string(),
            status_code: Some(200),
            stdout: String::new(),
            stderr: String::new(),
        };
        let delete_result = DesktopOllamaCommandResult {
            command: "DELETE /api/delete qwen3:latest".to_string(),
            status_code: Some(200),
            stdout: String::new(),
            stderr: String::new(),
        };

        let result = combine_stop_delete_result("qwen3:latest", Some(&stop_result), &delete_result);

        assert_eq!(
            result.command,
            "POST /api/generate stop qwen3:latest && DELETE /api/delete qwen3:latest"
        );
        assert_eq!(
            result.stdout,
            "Stopped running copy of qwen3:latest.\nDeleted qwen3:latest from Ollama."
        );
        assert_eq!(result.status_code, Some(200));
    }

    #[test]
    fn stop_delete_result_reports_disk_cleanup_when_model_was_not_running() {
        let delete_result = DesktopOllamaCommandResult {
            command: "DELETE /api/delete qwen3:latest".to_string(),
            status_code: Some(200),
            stdout: String::new(),
            stderr: String::new(),
        };

        let result = combine_stop_delete_result("qwen3:latest", None, &delete_result);

        assert_eq!(result.command, "DELETE /api/delete qwen3:latest");
        assert_eq!(result.stdout, "Deleted qwen3:latest from Ollama.");
        assert_eq!(result.status_code, Some(200));
    }
}
