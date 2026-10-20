//! Background runs that belong to a feature instead of a chat: the digest,
//! PiP, and Common ground runs. Each feature stores its own result.

use sqlx_postgres::PgPool;

use super::RunResult;

/// Hands a finished run to its feature. Returns false for other runs.
pub(super) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> RunResult<bool> {
    if run_id.starts_with(crate::digest::RUN_PREFIX) {
        crate::digest::complete(pool, run_id, runner_id, response_text).await?;
    } else if run_id.starts_with(crate::pip::RUN_PREFIX) {
        crate::pip::store::complete(pool, run_id, runner_id, response_text).await?;
    } else if run_id.starts_with(crate::common_ground::RUN_PREFIX) {
        crate::common_ground::complete(pool, run_id, runner_id, response_text).await?;
    } else {
        return Ok(false);
    }
    Ok(true)
}

/// Hands a failed run to its feature. Returns false for other runs.
pub(super) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    error_code: &str,
) -> RunResult<bool> {
    let runner = Some(runner_id);
    if run_id.starts_with(crate::digest::RUN_PREFIX) {
        crate::digest::fail(pool, run_id, runner, error_code).await?;
    } else if run_id.starts_with(crate::pip::RUN_PREFIX) {
        crate::pip::store::fail(pool, run_id, runner, error_code).await?;
    } else if run_id.starts_with(crate::common_ground::RUN_PREFIX) {
        crate::common_ground::fail(pool, run_id, runner, error_code).await?;
    } else {
        return Ok(false);
    }
    Ok(true)
}
