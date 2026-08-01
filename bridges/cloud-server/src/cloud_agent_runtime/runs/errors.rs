//! Typed failures exposed by the Cloud run domain boundary.

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Cloud agent run was not found for the requested transition")]
    NotFound,
    #[error("Cloud agent run persistence failed: {0}")]
    Persistence(#[from] sqlx_core::Error),
}

pub type RunResult<T> = Result<T, RunError>;

impl RunError {
    /// Preserve scheduled-task store compatibility while that adapter still
    /// exposes `sqlx::Error` as its public persistence boundary.
    pub fn into_persistence_error(self) -> sqlx_core::Error {
        match self {
            Self::Persistence(error) => error,
            Self::NotFound => sqlx_core::Error::Protocol(self.to_string()),
        }
    }
}
