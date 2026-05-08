use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::sandbox::{self, SandboxBackend};
use crate::{ExecutionPolicy, ToolContext, ToolResult};

use super::safety::{BashResultDetails, BashSafetyContext, structured_error_result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct BashOutputOptimization {
    pub provider: Option<&'static str>,
    pub enabled: bool,
    pub applied: bool,
    pub version: Option<String>,
    pub fallback_reason: Option<String>,
}

impl BashOutputOptimization {
    pub(super) fn disabled() -> Self {
        Self {
            provider: None,
            enabled: false,
            applied: false,
            version: None,
            fallback_reason: None,
        }
    }

    fn rtk_applied(version: String) -> Self {
        Self {
            provider: Some("rtk"),
            enabled: true,
            applied: true,
            version: Some(version),
            fallback_reason: None,
        }
    }

    fn rtk_fallback(reason: impl Into<String>, version: Option<String>) -> Self {
        Self {
            provider: Some("rtk"),
            enabled: true,
            applied: false,
            version,
            fallback_reason: Some(reason.into()),
        }
    }
}

pub(super) struct SpawnedProcess {
    pub child: Child,
    pub sandbox_backend: Option<SandboxBackend>,
    pub output_optimization: BashOutputOptimization,
    #[cfg(unix)]
    pub process_group_id: Option<u32>,
}

pub(super) async fn spawn_bash_process(
    command: &str,
    raw_output: bool,
    ctx: &ToolContext,
    safety: BashSafetyContext<'_>,
) -> Result<SpawnedProcess, ToolResult> {
    match ctx.execution_policy {
        ExecutionPolicy::Yolo => {
            let (process, output_optimization) =
                optimized_or_raw_bash_command(command, raw_output, ctx).await;
            let child = spawn_process(process).map_err(|error| {
                structured_error_result(
                    format!("Failed to spawn bash: {error}"),
                    BashResultDetails::error(command, safety, None, None),
                )
            })?;
            #[cfg(unix)]
            let process_group_id = child.id();
            Ok(SpawnedProcess {
                child,
                sandbox_backend: None,
                output_optimization,
                #[cfg(unix)]
                process_group_id,
            })
        }
        ExecutionPolicy::Safety => {
            let (sandboxed, backend) = match sandbox::prepare_bash_command(&ctx.cwd, command) {
                Ok(sandboxed) => sandboxed.into_parts(),
                Err(error) => {
                    let details = error.details().clone();
                    return Err(structured_error_result(
                        details.message().to_string(),
                        BashResultDetails::error(
                            command,
                            safety,
                            Some(details.backend()),
                            Some(&details),
                        ),
                    ));
                }
            };

            let child = spawn_process(configure_process_stdio(sandboxed)).map_err(|error| {
                let details = sandbox::backend_launch_failed_error(
                    backend,
                    format!("Failed to launch Linux sandbox backend: {error}"),
                );
                structured_error_result(
                    details.message().to_string(),
                    BashResultDetails::error(command, safety, Some(backend), Some(&details)),
                )
            })?;
            #[cfg(unix)]
            let process_group_id = child.id();

            Ok(SpawnedProcess {
                child,
                sandbox_backend: Some(backend),
                output_optimization: BashOutputOptimization::disabled(),
                #[cfg(unix)]
                process_group_id,
            })
        }
    }
}

async fn optimized_or_raw_bash_command(
    command: &str,
    raw_output: bool,
    ctx: &ToolContext,
) -> (Command, BashOutputOptimization) {
    if !rtk_enabled_from_env() {
        return (
            direct_bash_command(command, ctx),
            BashOutputOptimization::disabled(),
        );
    }

    if raw_output {
        return (
            direct_bash_command(command, ctx),
            BashOutputOptimization::rtk_fallback("raw output requested", None),
        );
    }

    let version = match detect_rtk_version().await {
        Ok(version) => version,
        Err(reason) => {
            return (
                direct_bash_command(command, ctx),
                BashOutputOptimization::rtk_fallback(reason, None),
            );
        }
    };

    (
        rtk_bash_command(command, ctx),
        BashOutputOptimization::rtk_applied(version),
    )
}

fn rtk_enabled_from_env() -> bool {
    std::env::var("KORDI_BASH_RTK")
        .or_else(|_| std::env::var("KORDI_RTK_ENABLED"))
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(super) async fn detect_rtk_version() -> Result<String, String> {
    let output = Command::new("rtk")
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("rtk not available: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("exit code {:?}", output.status.code())
        } else {
            stderr
        };
        return Err(format!("rtk --version failed: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if stdout.is_empty() {
        "rtk version unknown".to_string()
    } else {
        stdout
    })
}

fn direct_bash_command(command: &str, ctx: &ToolContext) -> Command {
    let mut process = Command::new("bash");
    process.arg("-c").arg(command).current_dir(&ctx.cwd);
    configure_process_stdio(process)
}

fn rtk_bash_command(command: &str, ctx: &ToolContext) -> Command {
    let mut process = Command::new("rtk");
    process
        .arg("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(&ctx.cwd);
    configure_process_stdio(process)
}

fn configure_process_stdio(mut process: Command) -> Command {
    process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process
}

fn spawn_process(mut process: Command) -> std::io::Result<Child> {
    #[cfg(unix)]
    {
        // Put the shell into its own process group so cancellation/timeouts can
        // terminate the whole command tree instead of only the immediate shell.
        unsafe {
            process.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }

    process.spawn()
}

#[cfg(unix)]
pub(super) async fn kill_running_process(child: &mut Child, process_group_id: Option<u32>) {
    if let Some(pgid) = process_group_id {
        let _ = send_signal_to_process_group(pgid, libc::SIGTERM);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    let _ = child.kill().await;

    if let Some(pgid) = process_group_id {
        let _ = send_signal_to_process_group(pgid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
pub(super) async fn kill_running_process(child: &mut Child) {
    let _ = child.kill().await;
}

#[cfg(unix)]
fn send_signal_to_process_group(process_group_id: u32, signal: i32) -> std::io::Result<()> {
    let target = -(process_group_id as i32);
    let rc = unsafe { libc::kill(target, signal) };
    if rc == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(()),
            _ => Err(error),
        }
    }
}
