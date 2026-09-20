use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use tokio::io::BufReader;
use tokio::process::Command;
use tracing::{debug, error, info};

use super::types::{PluginHostError, RegisteredCommand, RegisteredTool, HOST_JS};
use super::PluginHost;

impl PluginHost {
    /// Load plugins by spawning a Node.js process with the embedded host.js runtime.
    ///
    /// Writes host.js to a temp file, spawns Node with plugin paths as arguments,
    /// then reads startup notifications (tool_registered, command_registered, plugins_loaded).
    pub async fn load_plugins(plugin_paths: &[PathBuf]) -> Result<Self, PluginHostError> {
        if plugin_paths.is_empty() {
            return Err(PluginHostError::NoPlugins);
        }

        // Write host.js to a temp file
        let temp_dir = std::env::temp_dir().join("kordi-plugin-host");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| PluginHostError::Io(format!("create temp dir: {e}")))?;
        let host_js_path = temp_dir.join("host.js");
        publish_runtime(&host_js_path, HOST_JS.as_bytes())
            .map_err(|e| PluginHostError::Io(format!("write host.js: {e}")))?;

        // Build args: host.js + plugin paths
        let mut args: Vec<String> = vec![host_js_path.to_string_lossy().to_string()];
        for p in plugin_paths {
            args.push(p.to_string_lossy().to_string());
        }

        let mut child = Command::new("node")
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| PluginHostError::SpawnFailed(format!("node: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PluginHostError::SpawnFailed("node stdin pipe missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PluginHostError::SpawnFailed("node stdout pipe missing".into()))?;

        info!(
            "Plugin host spawned (pid: {:?}), loading {} plugin(s)",
            child.id(),
            plugin_paths.len()
        );

        let mut host = Self {
            child,
            stdin,
            stdout_reader: BufReader::new(stdout),
            next_id: AtomicU64::new(1),
            registered_tools: Vec::new(),
            registered_commands: Vec::new(),
            plugin_count: 0,
            ui_handler: None,
        };

        // Read startup notifications until plugins_loaded
        host.read_startup_notifications().await?;

        info!(
            "Plugin host ready: {} plugin(s), {} tool(s), {} command(s)",
            host.plugin_count,
            host.registered_tools.len(),
            host.registered_commands.len(),
        );

        Ok(host)
    }

    /// Read notifications emitted during plugin loading (tool_registered, command_registered,
    /// plugin_error, plugins_loaded). Returns when plugins_loaded is received or timeout.
    pub(super) async fn read_startup_notifications(&mut self) -> Result<(), PluginHostError> {
        let timeout = Duration::from_secs(10);

        loop {
            let msg = tokio::time::timeout(timeout, self.read_message())
                .await
                .map_err(|_| PluginHostError::Timeout("startup notifications".into()))?
                .map_err(|e| PluginHostError::Io(format!("read startup: {e}")))?;

            let msg = match msg {
                Some(m) => m,
                None => return Err(PluginHostError::ProcessExited),
            };

            // Startup messages are notifications (no id), with a method field
            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
            let params = msg.get("params").cloned().unwrap_or(serde_json::json!({}));

            match method {
                "tool_registered" => {
                    if let Ok(tool) = serde_json::from_value::<RegisteredTool>(params) {
                        info!("Plugin registered tool: {}", tool.name());
                        self.registered_tools.push(tool);
                    }
                }
                "command_registered" => {
                    if let Ok(cmd) = serde_json::from_value::<RegisteredCommand>(params) {
                        info!("Plugin registered command: {}", cmd.name());
                        self.registered_commands.push(cmd);
                    }
                }
                "plugin_error" => {
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("?");
                    let error = params.get("error").and_then(|v| v.as_str()).unwrap_or("?");
                    error!("Plugin load error [{}]: {}", path, error);
                }
                "plugins_loaded" => {
                    self.plugin_count =
                        params.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    return Ok(());
                }
                other => {
                    debug!("Unknown startup notification: {}", other);
                }
            }
        }
    }

    /// Kill the plugin host process.
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub(super) fn publish_runtime(
    destination: &std::path::Path,
    contents: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::Ordering;
    static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);
    // Node may already be opening the published file. Never truncate that
    // inode: complete a separate file, then atomically replace the name.
    let (temporary, mut file) = loop {
        let id = NEXT_WRITE.fetch_add(1, Ordering::Relaxed);
        let temporary = destination.with_extension(format!("{}.{id}.tmp", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let result = (|| {
        file.write_all(contents)?;
        drop(file);
        std::fs::rename(&temporary, destination)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
