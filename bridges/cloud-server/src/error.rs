use std::fmt;

#[derive(Debug)]
pub enum ServerInitError {
    Schema(rusqlite::Error),
    Migration {
        version: i64,
        description: &'static str,
        source: rusqlite::Error,
    },
}

impl fmt::Display for ServerInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Schema(err) => write!(f, "initialize cloud schema: {err}"),
            Self::Migration {
                version,
                description,
                source,
            } => write!(f, "apply migration v{version} ({description}): {source}"),
        }
    }
}

impl std::error::Error for ServerInitError {}
