//! Optional token accounting for one run. Production runs never install a
//! meter, so recording is a no-op; the System agent quality test installs one
//! around each replayed run to measure tokens and cost.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

/// Tokens a provider reported across every model call of one run.
#[derive(Debug, Default)]
pub struct UsageMeter {
    input_tokens: AtomicU64,
    output_tokens: AtomicU64,
    calls: AtomicU64,
    reported: AtomicU64,
}

/// A snapshot of a meter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Model calls observed.
    pub calls: u64,
    /// Model calls whose provider reported token counts.
    pub reported_calls: u64,
}

impl UsageMeter {
    pub fn snapshot(&self) -> Usage {
        Usage {
            input_tokens: self.input_tokens.load(Ordering::Relaxed),
            output_tokens: self.output_tokens.load(Ordering::Relaxed),
            calls: self.calls.load(Ordering::Relaxed),
            reported_calls: self.reported.load(Ordering::Relaxed),
        }
    }

    fn add(&self, input: Option<u64>, output: Option<u64>) {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if input.is_some() || output.is_some() {
            self.reported.fetch_add(1, Ordering::Relaxed);
        }
        self.input_tokens
            .fetch_add(input.unwrap_or(0), Ordering::Relaxed);
        self.output_tokens
            .fetch_add(output.unwrap_or(0), Ordering::Relaxed);
    }
}

tokio::task_local! {
    static METER: Arc<UsageMeter>;
}

/// Runs `future` with `meter` collecting the usage of every model call it
/// makes on this task.
pub async fn measure<F: Future>(meter: Arc<UsageMeter>, future: F) -> F::Output {
    METER.scope(meter, future).await
}

/// Records one model call. `None` means the provider reported no count.
pub(crate) fn record(input: Option<u64>, output: Option<u64>) {
    let _ = METER.try_with(|meter| meter.add(input, output));
}

/// Records one OMP assistant message, whose usage uses `input` and `output`.
pub(crate) fn record_omp_message(message: &Value) {
    if message["role"] != "assistant" {
        return;
    }
    let count = |names: [&str; 2]| {
        names
            .iter()
            .find_map(|name| message["usage"][*name].as_u64())
            .filter(|count| *count > 0)
    };
    record(
        count(["input", "input_tokens"]),
        count(["output", "output_tokens"]),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn recording_outside_a_measured_run_is_a_no_op() {
        record(Some(10), Some(2));
        let meter = Arc::new(UsageMeter::default());
        measure(meter.clone(), async {
            record(Some(100), Some(20));
            record(None, None);
            record_omp_message(&json!({"role": "assistant", "usage": {"input": 7, "output": 3}}));
            record_omp_message(&json!({"role": "toolResult", "usage": {"input": 99}}));
        })
        .await;
        assert_eq!(
            meter.snapshot(),
            Usage {
                input_tokens: 107,
                output_tokens: 23,
                calls: 3,
                reported_calls: 2,
            }
        );
    }
}
