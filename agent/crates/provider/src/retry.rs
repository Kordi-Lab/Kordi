use std::time::Duration;

use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::error::{ProviderError, Result};
use crate::types::{ProviderRetryEvent, RetryCallback};

pub async fn with_retry<F, Fut, T>(
    max_retries: u32,
    base_delay_ms: u64,
    max_retry_delay_ms: u64,
    cancel: CancellationToken,
    retry_callback: Option<RetryCallback>,
    f: F,
) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let max_attempts = max_retries.max(1);
    let mut last_err = None;
    let mut used_attempts = 0_u32;

    for attempt in 0..max_attempts {
        used_attempts = attempt + 1;
        let attempt_result = tokio::select! {
            result = f() => result,
            _ = cancel.cancelled() => {
                if let Some(callback) = &retry_callback {
                    callback(ProviderRetryEvent::End {
                        success: false,
                        attempt: used_attempts,
                        final_error: Some("Request cancelled".to_string()),
                    });
                }
                return Err(ProviderError::Cancelled);
            }
        };
        match attempt_result {
            Ok(result) => {
                if attempt > 0
                    && let Some(callback) = &retry_callback
                {
                    callback(ProviderRetryEvent::End {
                        success: true,
                        attempt: used_attempts,
                        final_error: None,
                    });
                }
                return Ok(result);
            }
            Err(error) => {
                let last_message = error.to_string();
                if !error.is_retryable() {
                    if attempt > 0
                        && let Some(callback) = &retry_callback
                    {
                        callback(ProviderRetryEvent::End {
                            success: false,
                            attempt: used_attempts,
                            final_error: Some(last_message),
                        });
                    }
                    return Err(error);
                }
                if attempt < max_attempts - 1 {
                    let server_delay_ms = error.retry_after_ms();
                    if let Some(server_delay_ms) = server_delay_ms
                        && max_retry_delay_ms > 0
                        && server_delay_ms > max_retry_delay_ms
                    {
                        tracing::warn!(
                            "Provider requested {}s retry delay, above configured maximum {}s",
                            server_delay_ms.div_ceil(1000),
                            max_retry_delay_ms.div_ceil(1000)
                        );
                        if let Some(callback) = &retry_callback {
                            callback(ProviderRetryEvent::End {
                                success: false,
                                attempt: used_attempts,
                                final_error: Some(last_message),
                            });
                        }
                        return Err(error);
                    }
                    let delay_ms = server_delay_ms.unwrap_or_else(|| {
                        base_delay_ms.saturating_mul(2u64.saturating_pow(attempt))
                    });
                    let delay = Duration::from_millis(delay_ms);
                    tracing::warn!(
                        "Provider request failed (attempt {}), retrying in {:?}",
                        used_attempts,
                        delay
                    );
                    if let Some(callback) = &retry_callback {
                        callback(ProviderRetryEvent::Start {
                            attempt: used_attempts,
                            max_attempts,
                            delay_ms,
                            error_message: last_message,
                        });
                    }
                    tokio::select! {
                        _ = sleep(delay) => {}
                        _ = cancel.cancelled() => {
                            if let Some(callback) = &retry_callback {
                                callback(ProviderRetryEvent::End {
                                    success: false,
                                    attempt: used_attempts,
                                    final_error: Some("Retry cancelled".to_string()),
                                });
                            }
                            return Err(ProviderError::Cancelled);
                        }
                    }
                }
                last_err = Some(error);
            }
        }
    }

    let last_err =
        last_err.unwrap_or_else(|| ProviderError::other("No provider attempts were made", false));
    let final_error = last_err.to_string();
    if let Some(callback) = &retry_callback {
        callback(ProviderRetryEvent::End {
            success: false,
            attempt: used_attempts,
            final_error: Some(final_error.clone()),
        });
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProviderHttpError;
    use reqwest::StatusCode;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn http_error(status: StatusCode) -> ProviderError {
        http_error_with_retry_after(status, None)
    }

    fn http_error_with_retry_after(
        status: StatusCode,
        retry_after_ms: Option<u64>,
    ) -> ProviderError {
        ProviderError::Http(Box::new(ProviderHttpError {
            provider: "test".to_string(),
            operation: "test".to_string(),
            status,
            url: "https://example.com/v1/responses".to_string(),
            content_type: Some("application/json".to_string()),
            message: "temporary".to_string(),
            code: None,
            request_id: None,
            cf_ray: None,
            retry_after_ms,
            body_truncated: false,
            cloudflare_block: false,
            hint: None,
        }))
    }

    #[tokio::test]
    async fn cancels_in_flight_attempt_immediately() {
        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            with_retry(3, 1_000, 60_000, cancel_for_task, None, || async {
                std::future::pending::<Result<()>>().await
            })
            .await
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();

        let result = tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("cancel should interrupt pending attempt")
            .expect("task should not panic");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Request cancelled")
        );
    }

    #[tokio::test]
    async fn test_retry_succeeds_on_second_attempt() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let result = with_retry(3, 1, 60_000, CancellationToken::new(), None, || {
            let c = c.clone();
            async move {
                let attempt = c.fetch_add(1, Ordering::SeqCst);
                if attempt == 0 {
                    Err(http_error(StatusCode::TOO_MANY_REQUESTS))
                } else {
                    Ok(42)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_retry_all_fail() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let result: Result<i32> = with_retry(3, 1, 60_000, CancellationToken::new(), None, || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(http_error(StatusCode::TOO_MANY_REQUESTS))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 3);
        assert!(
            !result
                .unwrap_err()
                .to_string()
                .contains("Retry failed after")
        );
    }

    #[tokio::test]
    async fn test_non_retryable_error_stops_immediately() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let result: Result<i32> = with_retry(3, 1, 60_000, CancellationToken::new(), None, || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(http_error(StatusCode::UNAUTHORIZED))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn typed_status_matrix_controls_actual_attempt_count() {
        for status in [408, 429, 500, 502, 503, 504] {
            let counter = Arc::new(AtomicU32::new(0));
            let result: Result<()> =
                with_retry(2, 0, 60_000, CancellationToken::new(), None, || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async move {
                        Err(http_error(
                            StatusCode::from_u16(status).expect("valid status"),
                        ))
                    }
                })
                .await;
            assert!(result.is_err());
            assert_eq!(
                counter.load(Ordering::SeqCst),
                2,
                "status {status} should retry"
            );
        }

        for status in [400, 401, 403, 404, 422] {
            let counter = Arc::new(AtomicU32::new(0));
            let result: Result<()> =
                with_retry(3, 0, 60_000, CancellationToken::new(), None, || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async move {
                        Err(http_error(
                            StatusCode::from_u16(status).expect("valid status"),
                        ))
                    }
                })
                .await;
            assert!(result.is_err());
            assert_eq!(
                counter.load(Ordering::SeqCst),
                1,
                "status {status} should be terminal"
            );
        }
    }

    #[tokio::test]
    async fn retry_after_reaches_callback_and_respects_configured_bound() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let callback_events = events.clone();
        let callback: RetryCallback = Arc::new(move |event| {
            callback_events.lock().unwrap().push(event);
        });
        let counter = Arc::new(AtomicU32::new(0));
        let result = with_retry(
            2,
            1_000,
            60_000,
            CancellationToken::new(),
            Some(callback),
            || {
                let attempt = counter.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(http_error_with_retry_after(
                            StatusCode::TOO_MANY_REQUESTS,
                            Some(1),
                        ))
                    } else {
                        Ok(42)
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap(), 42);
        assert!(matches!(
            events.lock().unwrap().first(),
            Some(ProviderRetryEvent::Start { delay_ms: 1, .. })
        ));

        let counter = Arc::new(AtomicU32::new(0));
        let result: Result<()> = with_retry(3, 0, 10, CancellationToken::new(), None, || {
            counter.fetch_add(1, Ordering::SeqCst);
            async {
                Err(http_error_with_retry_after(
                    StatusCode::TOO_MANY_REQUESTS,
                    Some(11),
                ))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_callback_closes_with_typed_terminal_error_and_exact_attempt_count() {
        let counter = Arc::new(AtomicU32::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let callback_events = events.clone();
        let callback: RetryCallback = Arc::new(move |event| {
            callback_events.lock().unwrap().push(event);
        });
        let result: Result<()> = with_retry(
            3,
            1,
            60_000,
            CancellationToken::new(),
            Some(callback),
            || {
                let counter = counter.clone();
                async move {
                    let attempt = counter.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        Err(http_error(StatusCode::TOO_MANY_REQUESTS))
                    } else {
                        Err(http_error(StatusCode::FORBIDDEN))
                    }
                }
            },
        )
        .await;

        let error = result.expect_err("second attempt should be terminal");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
        assert!(!error.to_string().contains("Provider error:"));
        assert!(!error.to_string().contains("Retry failed after"));

        let events = events.lock().unwrap();
        assert!(matches!(
            events.as_slice(),
            [
                ProviderRetryEvent::Start {
                    attempt: 1,
                    max_attempts: 3,
                    ..
                },
                ProviderRetryEvent::End {
                    success: false,
                    attempt: 2,
                    final_error: Some(_),
                }
            ]
        ));
    }

    #[tokio::test]
    async fn test_retry_succeeds_first_try() {
        let result = with_retry(3, 1, 60_000, CancellationToken::new(), None, || async {
            Ok::<_, ProviderError>(99)
        })
        .await;
        assert_eq!(result.unwrap(), 99);
    }
}
