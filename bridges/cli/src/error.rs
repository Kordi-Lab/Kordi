use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum DbError {
    HomeDirUnavailable,
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    Open {
        path: PathBuf,
        source: rusqlite::Error,
    },
    Migrate(rusqlite::Error),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirUnavailable => write!(f, "cannot determine home directory"),
            Self::CreateDir { path, source } => {
                write!(f, "create db dir {}: {}", path.display(), source)
            }
            Self::Open { path, source } => write!(f, "open db {}: {}", path.display(), source),
            Self::Migrate(source) => write!(f, "run db migrations: {}", source),
        }
    }
}

impl std::error::Error for DbError {}

#[derive(Debug)]
pub enum ClientConfigError {
    HomeDirUnavailable,
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    Serialize(serde_json::Error),
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for ClientConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirUnavailable => write!(f, "cannot determine home directory"),
            Self::Read { path, source } => write!(f, "read config {}: {}", path.display(), source),
            Self::Parse { path, source } => {
                write!(f, "parse config {}: {}", path.display(), source)
            }
            Self::CreateDir { path, source } => {
                write!(f, "create config dir {}: {}", path.display(), source)
            }
            Self::Serialize(source) => write!(f, "serialize config: {}", source),
            Self::Write { path, source } => {
                write!(f, "write config {}: {}", path.display(), source)
            }
        }
    }
}

impl std::error::Error for ClientConfigError {}

#[derive(Debug)]
pub enum IdentityError {
    HomeDirUnavailable,
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    DecodeSecretKey {
        source: String,
    },
    InvalidSecretKeyLength {
        actual: usize,
    },
    Serialize(serde_json::Error),
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirUnavailable => write!(f, "cannot determine home directory"),
            Self::CreateDir { path, source } => {
                write!(f, "create identity dir {}: {}", path.display(), source)
            }
            Self::Read { path, source } => write!(f, "read keypair {}: {}", path.display(), source),
            Self::Parse { path, source } => {
                write!(f, "parse keypair {}: {}", path.display(), source)
            }
            Self::DecodeSecretKey { source } => write!(f, "decode secret key: {}", source),
            Self::InvalidSecretKeyLength { actual } => {
                write!(f, "secret key must be 32 bytes, got {}", actual)
            }
            Self::Serialize(source) => write!(f, "serialize keypair: {}", source),
            Self::Write { path, source } => {
                write!(f, "write keypair {}: {}", path.display(), source)
            }
        }
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug)]
pub enum DaemonConfigError {
    HomeDirUnavailable,
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    Serialize(serde_json::Error),
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    ClientConfig(ClientConfigError),
}

impl fmt::Display for DaemonConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirUnavailable => write!(f, "cannot determine home directory"),
            Self::Read { path, source } => {
                write!(f, "read daemon config {}: {}", path.display(), source)
            }
            Self::Parse { path, source } => {
                write!(f, "parse daemon config {}: {}", path.display(), source)
            }
            Self::CreateDir { path, source } => {
                write!(f, "create daemon config dir {}: {}", path.display(), source)
            }
            Self::Serialize(source) => write!(f, "serialize daemon config: {}", source),
            Self::Write { path, source } => {
                write!(f, "write daemon config {}: {}", path.display(), source)
            }
            Self::ClientConfig(source) => write!(f, "load client config: {}", source),
        }
    }
}

impl std::error::Error for DaemonConfigError {}

#[derive(Debug)]
pub enum WorkspaceError {
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    Serialize(serde_json::Error),
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CreateDir { path, source } => {
                write!(f, "create workspace dir {}: {}", path.display(), source)
            }
            Self::Serialize(source) => write!(f, "serialize workspace metadata: {}", source),
            Self::Write { path, source } => {
                write!(f, "write workspace file {}: {}", path.display(), source)
            }
            Self::Read { path, source } => {
                write!(f, "read workspace file {}: {}", path.display(), source)
            }
            Self::Parse { path, source } => {
                write!(f, "parse workspace file {}: {}", path.display(), source)
            }
        }
    }
}

impl std::error::Error for WorkspaceError {}

#[derive(Debug)]
pub enum ServerInitError {
    Schema(rusqlite::Error),
    AddColumn {
        table: &'static str,
        column: &'static str,
        source: rusqlite::Error,
    },
    PrepareTableInfo(rusqlite::Error),
    QueryTableInfo(rusqlite::Error),
    RegisteredNodesMigration(rusqlite::Error),
    ServerProjectsMigration(rusqlite::Error),
    RemoveLegacyUserState(rusqlite::Error),
}

impl fmt::Display for ServerInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Schema(source) => write!(f, "initialize server schema: {}", source),
            Self::AddColumn {
                table,
                column,
                source,
            } => {
                write!(f, "add column {}.{}: {}", table, column, source)
            }
            Self::PrepareTableInfo(source) => write!(f, "prepare table info pragma: {}", source),
            Self::QueryTableInfo(source) => write!(f, "query table info pragma: {}", source),
            Self::RegisteredNodesMigration(source) => {
                write!(f, "migrate registered_nodes: {}", source)
            }
            Self::ServerProjectsMigration(source) => {
                write!(f, "migrate server_projects: {}", source)
            }
            Self::RemoveLegacyUserState(source) => {
                write!(f, "remove legacy user state: {}", source)
            }
        }
    }
}

impl std::error::Error for ServerInitError {}
