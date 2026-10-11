//! Worker process spawning and the opt-in pool of pre-warmed, one-shot workers.
//!
//! A warm worker is started exactly like a per-turn worker and left idle on
//! its first stdin line. It still serves exactly one turn.

use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
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
    /// Attaches a freshly spawned worker; its stderr counts toward the turn
    /// from spawn on.
    pub(crate) fn attach(mut child: ChildGuard) -> Result<Self, RuntimeError> {
        let stderr = child.0.stderr.take().ok_or(RuntimeError::Spawn)?;
        let (stderr_overflow_tx, stderr_overflow) = oneshot::channel();
        tokio::spawn(drain_stderr(stderr, async {
            Ok::<_, oneshot::error::RecvError>(stderr_overflow_tx)
        }));
        Self::with_stderr_overflow(child, stderr_overflow)
    }

    fn with_stderr_overflow(
        mut child: ChildGuard,
        stderr_overflow: oneshot::Receiver<()>,
    ) -> Result<Self, RuntimeError> {
        let stdin = child.0.stdin.take().ok_or(RuntimeError::Spawn)?;
        let stdout = child.0.stdout.take().ok_or(RuntimeError::Spawn)?;
        Ok(Self {
            _child: child,
            stdin,
            stdout,
            stderr_overflow,
        })
    }
}

/// Reads a worker's stderr until it closes so the worker can never block on
/// a full pipe. Output is discarded until `attached` yields the turn's
/// overflow signal; from then on it counts toward the per-turn limit.
async fn drain_stderr(
    mut stderr: ChildStderr,
    attached: impl Future<Output = Result<oneshot::Sender<()>, oneshot::error::RecvError>>,
) {
    tokio::pin!(attached);
    let mut overflow = None;
    let mut waiting = true;
    let mut total = 0usize;
    let mut chunk = [0u8; 4096];
    loop {
        let size = tokio::select! {
            biased;
            result = &mut attached, if waiting => {
                waiting = false;
                // A discarded warm worker never attaches; keep draining
                // until its process group is killed.
                overflow = result.ok();
                continue;
            }
            result = stderr.read(&mut chunk) => match result {
                Ok(0) | Err(_) => break,
                Ok(size) => size,
            },
        };
        if overflow.is_none() {
            continue;
        }
        total += size;
        if total > MAX_STDERR_BYTES {
            if let Some(overflow) = overflow.take() {
                let _ = overflow.send(());
            }
            break;
        }
    }
}

/// A pre-warmed worker whose stderr is drained from spawn time, so boot
/// logging while it idles cannot fill the pipe and stall it.
pub(crate) struct WarmWorker {
    child: ChildGuard,
    attach_stderr: oneshot::Sender<oneshot::Sender<()>>,
}

impl WarmWorker {
    fn spawn(command: &WorkerCommand) -> Result<Self, RuntimeError> {
        let mut child = spawn_worker(command)?;
        let stderr = child.0.stderr.take().ok_or(RuntimeError::Spawn)?;
        let (attach_stderr, attached) = oneshot::channel();
        tokio::spawn(drain_stderr(stderr, attached));
        Ok(Self {
            child,
            attach_stderr,
        })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.0.try_wait(), Ok(None))
    }

    /// Hands the worker to a turn. Idle-time stderr does not count toward
    /// the turn's stderr limit.
    pub(crate) fn attach(self) -> Result<AttachedWorker, RuntimeError> {
        let (stderr_overflow_tx, stderr_overflow) = oneshot::channel();
        let _ = self.attach_stderr.send(stderr_overflow_tx);
        AttachedWorker::with_stderr_overflow(self.child, stderr_overflow)
    }
}

/// Idle, spawned-but-unused workers shared by every clone of an `OmpRuntime`.
/// Dropping the last clone drops the guards, which kill each process group.
pub(crate) struct WarmPool {
    target: usize,
    state: Mutex<PoolState>,
}

struct PoolState {
    idle: Vec<WarmWorker>,
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
    pub(crate) fn take(&self) -> Option<WarmWorker> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while let Some(mut worker) = state.idle.pop() {
            if worker.is_alive() {
                return Some(worker);
            }
        }
        None
    }

    /// Tops the pool up to its target. Needs a Tokio runtime context. A spawn
    /// failure stops the fill; the next turn spawns on demand and reports it.
    pub(crate) fn fill(&self, command: &WorkerCommand) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.idle.retain_mut(WarmWorker::is_alive);
        while !state.closed && state.idle.len() < self.target {
            match WarmWorker::spawn(command) {
                Ok(worker) => state.idle.push(worker),
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
