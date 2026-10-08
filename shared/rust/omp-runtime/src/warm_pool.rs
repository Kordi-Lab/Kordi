//! Worker process spawning and the opt-in pool of pre-warmed, one-shot workers.
//!
//! A warm worker is started exactly like a per-turn worker and left idle on
//! its first stdin line. It still serves exactly one turn.

use std::sync::{Arc, Mutex};

use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

use super::supervisor_helpers::ChildGuard;
use super::{AsyncReadExt, MAX_STDERR_BYTES, RuntimeError, WorkerCommand};

/// Starts a worker with a cleared environment in its own process group.
pub(crate) fn spawn_worker(command: &WorkerCommand) -> Result<ChildGuard, RuntimeError> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        process.env("PATH", path);
    }
    process.env("NODE_ENV", "production");
    process.stdin(std::process::Stdio::piped());
    process.stdout(std::process::Stdio::piped());
    process.stderr(std::process::Stdio::piped());
    process.kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    Ok(ChildGuard::new(
        process.spawn().map_err(|_| RuntimeError::Spawn)?,
    ))
}

/// A worker whose pipes are attached to the current turn.
pub(crate) struct AttachedWorker {
    pub(crate) _child: ChildGuard,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: ChildStdout,
    pub(crate) stderr_overflow: oneshot::Receiver<()>,
}

impl AttachedWorker {
    pub(crate) fn attach(mut child: ChildGuard) -> Result<Self, RuntimeError> {
        let stdin = child.0.stdin.take().ok_or(RuntimeError::Spawn)?;
        let stdout = child.0.stdout.take().ok_or(RuntimeError::Spawn)?;
        let stderr = child.0.stderr.take().ok_or(RuntimeError::Spawn)?;
        let (stderr_overflow_tx, stderr_overflow) = oneshot::channel();
        tokio::spawn(async move {
            let mut reader = stderr;
            let mut total = 0usize;
            let mut chunk = [0u8; 4096];
            while let Ok(size) = reader.read(&mut chunk).await {
                if size == 0 {
                    break;
                }
                total += size;
                if total > MAX_STDERR_BYTES {
                    let _ = stderr_overflow_tx.send(());
                    break;
                }
            }
        });
        Ok(Self {
            _child: child,
            stdin,
            stdout,
            stderr_overflow,
        })
    }
}

/// Idle, spawned-but-unused workers shared by every clone of an `OmpRuntime`.
/// Dropping the last clone drops the guards, which kill each process group.
pub(crate) struct WarmPool {
    target: usize,
    state: Mutex<PoolState>,
}

struct PoolState {
    idle: Vec<ChildGuard>,
    closed: bool,
}

impl WarmPool {
    pub(crate) fn new(target: usize) -> Self {
        Self {
            target,
            state: Mutex::new(PoolState {
                idle: Vec::with_capacity(target),
                closed: false,
            }),
        }
    }

    /// Returns a live idle worker, discarding any that exited on their own.
    pub(crate) fn take(&self) -> Option<ChildGuard> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while let Some(mut child) = state.idle.pop() {
            if matches!(child.0.try_wait(), Ok(None)) {
                return Some(child);
            }
        }
        None
    }

    /// Tops the pool up to its target. Needs a Tokio runtime context. A spawn
    /// failure stops the fill; the next turn spawns on demand and reports it.
    pub(crate) fn fill(&self, command: &WorkerCommand) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state
            .idle
            .retain_mut(|child| matches!(child.0.try_wait(), Ok(None)));
        while !state.closed && state.idle.len() < self.target {
            match spawn_worker(command) {
                Ok(child) => state.idle.push(child),
                Err(_) => break,
            }
        }
    }

    /// Replaces a taken worker without delaying the current turn.
    pub(crate) fn refill_in_background(self: &Arc<Self>, command: &WorkerCommand) {
        let pool = Arc::clone(self);
        let command = command.clone();
        tokio::spawn(async move { pool.fill(&command) });
    }

    /// Kills idle workers and stops future refills.
    pub(crate) fn shutdown(&self) {
        let idle = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            std::mem::take(&mut state.idle)
        };
        drop(idle);
    }

    #[cfg(test)]
    pub(crate) fn idle_len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .idle
            .len()
    }
}

#[cfg(all(test, unix))]
#[path = "warm_pool_tests.rs"]
mod tests;
