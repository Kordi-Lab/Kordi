use super::{error, RenderSandboxConfig, CHECKPOINT_LIMIT};
use crate::sandbox_client::SandboxClientError;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(super) struct Workspace {
    directory: PathBuf,
    _lock: File,
}
fn lock(path: &Path, wait: bool) -> Result<File, SandboxClientError> {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    let attempts = if wait { 20 } else { 1 };
    for attempt in 0..attempts {
        if file.try_lock().is_ok() {
            return Ok(file);
        }
        if attempt + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Err(error("Render workspace is already in use"))
}
impl Workspace {
    pub fn acquire(config: &RenderSandboxConfig, id: &str) -> Result<Self, SandboxClientError> {
        if id.is_empty() || id.len() > 256 {
            return Err(error("Invalid workspace identity"));
        }
        let _provision = lock(&config.root.join(".provision.lock"), true)?;
        let key = format!("{:x}", Sha256::digest(id.as_bytes()));
        let directory = config.root.join(key);
        if !directory.exists() {
            let count = std::fs::read_dir(&config.root)?.try_fold(0usize, |count, entry| {
                Ok::<_, std::io::Error>(count + usize::from(entry?.file_type()?.is_dir()))
            })?;
            if count >= config.max_workspaces {
                return Err(error("Render workspace capacity reached"));
            }
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            builder.create(&directory)?;
            File::open(&config.root)?.sync_all()?;
        }
        let lease = lock(&directory.join("lease.lock"), false)?;
        Ok(Self {
            directory,
            _lock: lease,
        })
    }
    pub fn load(&self) -> Result<Option<Vec<u8>>, SandboxClientError> {
        let file = match File::open(self.directory.join("checkpoint.json")) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let mut bytes = Vec::new();
        file.take((CHECKPOINT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > CHECKPOINT_LIMIT {
            return Err(error("Workspace checkpoint exceeds limit"));
        }
        Ok(Some(bytes))
    }
    pub fn commit(&self, bytes: &[u8]) -> Result<(), SandboxClientError> {
        if bytes.len() > CHECKPOINT_LIMIT {
            return Err(error("Workspace checkpoint exceeds limit"));
        }
        // Checkpoints remain opaque on the host; extraction happens only in a
        // new sandbox as an unprivileged user. Never execute guest files here.
        let temporary = self.directory.join("checkpoint.pending");
        let mut options = OpenOptions::new();
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(temporary, self.directory.join("checkpoint.json"))?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}
