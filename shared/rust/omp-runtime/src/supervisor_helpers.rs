use super::*;

#[cfg(unix)]
pub(crate) async fn acquire_computer_lock(
    path: &std::path::Path,
    cancel: &CancellationToken,
    timeout_ms: u64,
) -> Result<std::fs::File, RuntimeError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let parent = path.parent().ok_or(RuntimeError::InvalidRequest)?;
    let metadata = std::fs::metadata(parent).map_err(|_| RuntimeError::InvalidRequest)?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(RuntimeError::InvalidRequest);
    }
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|_| RuntimeError::InvalidRequest)?;
    let metadata = file.metadata().map_err(|_| RuntimeError::InvalidRequest)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(RuntimeError::InvalidRequest);
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(RuntimeError::InvalidRequest);
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(RuntimeError::Cancelled),
            _ = tokio::time::sleep_until(deadline) => return Err(RuntimeError::Timeout),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

#[cfg(not(unix))]
pub(crate) async fn acquire_computer_lock(
    _: &std::path::Path,
    _: &CancellationToken,
    _: u64,
) -> Result<std::fs::File, RuntimeError> {
    Err(RuntimeError::InvalidRequest)
}

pub(crate) fn validate_request(request: &RunRequest) -> Result<(), RuntimeError> {
    if [
        &request.run_id,
        &request.request_id,
        &request.attempt_id,
        &request.session_id,
        &request.model.provider,
        &request.model.id,
    ]
    .iter()
    .any(|value| value.trim().is_empty() || value.len() > 4096)
        || request
            .message_entry_ids
            .as_ref()
            .is_some_and(|ids| ids.len() != request.messages.len())
        || (!request.capabilities.owner_local
            && (request.capabilities.computer || request.capabilities.browser))
        || request.hooks.len() > 2
        || request
            .hooks
            .iter()
            .any(|hook| !matches!(hook.as_str(), "context" | "before_provider_request"))
        || request.hooks.len() == 2 && request.hooks[0] == request.hooks[1]
        || match request.auth.kind {
            AuthKind::None => {
                request.auth.credential.is_some()
                    || request
                        .model
                        .base_url
                        .as_ref()
                        .is_none_or(|url| url.trim().is_empty())
            }
            AuthKind::ApiKey | AuthKind::Oauth => request
                .auth
                .credential
                .as_ref()
                .is_none_or(|value| value.trim().is_empty() || value.len() > 4096),
        }
        || request.limits.timeout_ms == 0
        || request.limits.timeout_ms > 3_600_000
        || request.limits.max_output_bytes == 0
        || request.limits.max_output_bytes > 32 * 1024 * 1024
        || request.limits.max_tool_calls > 128
        || request.limits.max_steps == 0
        || request.limits.max_steps > 128
    {
        return Err(RuntimeError::InvalidRequest);
    }
    Ok(())
}

pub(crate) fn check_frame(
    request: &RunRequest,
    ready: bool,
    schema_version: u32,
    run_id: &str,
    attempt_id: &str,
    sequence: u64,
    last_sequence: &mut Option<u64>,
) -> Result<(), RuntimeError> {
    if !ready
        || schema_version != SCHEMA_VERSION
        || run_id != request.run_id
        || attempt_id != request.attempt_id
        || last_sequence.map_or(sequence != 1, |last| last.checked_add(1) != Some(sequence))
    {
        return Err(RuntimeError::Protocol);
    }
    *last_sequence = Some(sequence);
    Ok(())
}

pub(crate) async fn write_json_line<T: serde::Serialize>(
    stdin: &mut ChildStdin,
    value: &T,
) -> Result<(), RuntimeError> {
    let mut line = serde_json::to_vec(value).map_err(|_| RuntimeError::Protocol)?;
    if line.len() > MAX_REQUEST_BYTES {
        return Err(RuntimeError::OutputLimit);
    }
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|_| RuntimeError::UnexpectedExit)
}

pub(crate) async fn read_line_bounded<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    total: &mut usize,
    max_total: usize,
) -> Result<Option<Vec<u8>>, RuntimeError> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| RuntimeError::UnexpectedExit)?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(RuntimeError::Protocol)
            };
        }
        let size = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(size) > MAX_LINE_BYTES
            || total.saturating_add(size) > max_total
        {
            return Err(RuntimeError::OutputLimit);
        }
        line.extend_from_slice(&available[..size]);
        let complete = line.last() == Some(&b'\n');
        reader.consume(size);
        *total += size;
        if complete {
            line.pop();
            return Ok(Some(line));
        }
    }
}

pub(crate) struct ChildGuard(pub(crate) Child, #[cfg(unix)] Option<u32>);

pub(crate) struct ToolCancelGuard(pub(crate) CancellationToken);

impl Drop for ToolCancelGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl ChildGuard {
    pub(crate) fn new(child: Child) -> Self {
        #[cfg(unix)]
        let process_group = child.id();
        Self(
            child,
            #[cfg(unix)]
            process_group,
        )
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.1 {
            // The child is in its own process group. Kill any worker descendants
            // along with it when a turn is cancelled, times out, or completes.
            // Keep the group ID after the leader exits: descendants may still
            // hold pipes or native resources open.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.0.start_kill();
    }
}
