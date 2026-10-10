//! How the OMP worker process is started. Flags only: provider credentials
//! travel over the child's stdin, never through this command.
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Clone)]
pub struct WorkerCommand {
    pub program: PathBuf,
    /// Executable/script flags only. Never place auth material here.
    pub args: Vec<OsString>,
    /// Stable file inside the owning user's private app-data directory.
    pub computer_lock_path: Option<PathBuf>,
}

impl WorkerCommand {
    pub fn sidecar(path: impl Into<PathBuf>) -> Self {
        Self {
            program: path.into(),
            args: Vec::new(),
            computer_lock_path: None,
        }
    }

    pub fn node(script: impl Into<PathBuf>) -> Self {
        Self {
            program: PathBuf::from("node"),
            args: vec![script.into().into_os_string()],
            computer_lock_path: None,
        }
    }

    pub fn with_computer_lock(mut self, path: impl Into<PathBuf>) -> Self {
        self.computer_lock_path = Some(path.into());
        self
    }
}
