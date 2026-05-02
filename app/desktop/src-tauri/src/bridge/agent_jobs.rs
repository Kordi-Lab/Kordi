use std::collections::{HashMap, HashSet};

pub(in crate::bridge) const MAX_ACTIVE_AGENT_JOBS_PER_USER: usize = 8;

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct QueuedBridgeAgentJob {
    pub id: String,
    pub requesting_user_key: String,
    pub chat_queue_key: String,
    pub created_at_ms: i64,
    pub next_retry_at_ms: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct RunningBridgeAgentJob {
    pub id: String,
    pub requesting_user_key: String,
    pub chat_queue_key: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) enum AgentJobRunResult {
    Responded,
    TerminalFailure(String),
    RetryableStartFailure(String),
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::bridge) struct AgentJobStatusUpdate {
    pub status: String,
    pub next_retry_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

fn retry_delay_ms(retry_count: i64) -> i64 {
    let retry_count = retry_count.clamp(0, 4) as u32;
    5_000_i64.saturating_mul(2_i64.saturating_pow(retry_count))
}

#[allow(dead_code)]
pub(in crate::bridge) fn job_status_update_for_run_result(
    result: AgentJobRunResult,
    now_ms: i64,
    retry_count: i64,
) -> AgentJobStatusUpdate {
    match result {
        AgentJobRunResult::Responded => AgentJobStatusUpdate {
            status: "responded".to_string(),
            next_retry_at_ms: None,
            completed_at_ms: Some(now_ms),
            last_error: None,
        },
        AgentJobRunResult::TerminalFailure(error) => AgentJobStatusUpdate {
            status: "processing_failed".to_string(),
            next_retry_at_ms: None,
            completed_at_ms: Some(now_ms),
            last_error: Some(error),
        },
        AgentJobRunResult::RetryableStartFailure(error) => AgentJobStatusUpdate {
            status: "retry_wait".to_string(),
            next_retry_at_ms: Some(now_ms.saturating_add(retry_delay_ms(retry_count))),
            completed_at_ms: None,
            last_error: Some(error),
        },
    }
}

#[allow(dead_code)]
pub(in crate::bridge) fn select_startable_jobs(
    queued_jobs: &[QueuedBridgeAgentJob],
    running_jobs: &[RunningBridgeAgentJob],
    now_ms: i64,
) -> Vec<String> {
    let mut active_by_user: HashMap<&str, usize> = HashMap::new();
    let mut blocked_chats: HashSet<&str> = HashSet::new();
    for job in running_jobs {
        *active_by_user
            .entry(job.requesting_user_key.as_str())
            .or_default() += 1;
        blocked_chats.insert(job.chat_queue_key.as_str());
    }

    let mut runnable: Vec<&QueuedBridgeAgentJob> = queued_jobs
        .iter()
        .filter(|job| {
            job.next_retry_at_ms
                .is_none_or(|retry_at_ms| retry_at_ms <= now_ms)
        })
        .collect();
    runnable.sort_by(|left, right| {
        left.created_at_ms
            .cmp(&right.created_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut selected = Vec::new();
    for job in runnable {
        if blocked_chats.contains(job.chat_queue_key.as_str()) {
            continue;
        }

        let active_for_user = active_by_user
            .entry(job.requesting_user_key.as_str())
            .or_default();
        if *active_for_user >= MAX_ACTIVE_AGENT_JOBS_PER_USER {
            continue;
        }

        selected.push(job.id.clone());
        *active_for_user += 1;
        blocked_chats.insert(job.chat_queue_key.as_str());
    }

    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued(
        id: &str,
        requesting_user_key: &str,
        chat_queue_key: &str,
        created_at_ms: i64,
    ) -> QueuedBridgeAgentJob {
        QueuedBridgeAgentJob {
            id: id.to_string(),
            requesting_user_key: requesting_user_key.to_string(),
            chat_queue_key: chat_queue_key.to_string(),
            created_at_ms,
            next_retry_at_ms: None,
        }
    }

    fn running(id: &str, requesting_user_key: &str, chat_queue_key: &str) -> RunningBridgeAgentJob {
        RunningBridgeAgentJob {
            id: id.to_string(),
            requesting_user_key: requesting_user_key.to_string(),
            chat_queue_key: chat_queue_key.to_string(),
        }
    }

    #[test]
    fn retryable_start_failure_returns_job_to_queue_not_failed() {
        let update = job_status_update_for_run_result(
            AgentJobRunResult::RetryableStartFailure("agent runtime busy".to_string()),
            10_000,
            2,
        );

        assert_eq!(update.status, "retry_wait");
        assert_eq!(update.completed_at_ms, None);
        assert_eq!(update.last_error.as_deref(), Some("agent runtime busy"));
        assert!(update.next_retry_at_ms.expect("retry at") > 10_000);
    }

    #[test]
    fn completed_job_starts_next_queued_same_user_job() {
        let running_jobs: Vec<_> = (0..MAX_ACTIVE_AGENT_JOBS_PER_USER)
            .map(|index| {
                running(
                    &format!("running-{index}"),
                    "user-a",
                    &format!("chat-a-{index}"),
                )
            })
            .collect();
        let queued_jobs = vec![queued("job-next", "user-a", "chat-next", 1_000)];
        assert!(select_startable_jobs(&queued_jobs, &running_jobs, 2_000).is_empty());

        let after_completion = running_jobs
            .iter()
            .filter(|job| job.id != "running-0")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            select_startable_jobs(&queued_jobs, &after_completion, 2_000),
            vec!["job-next".to_string()]
        );
    }

    #[test]
    fn scheduler_starts_at_most_eight_jobs_per_user() {
        let queued_jobs: Vec<_> = (0..10)
            .map(|index| {
                queued(
                    &format!("job-{index}"),
                    "user-a",
                    &format!("chat-{index}"),
                    index,
                )
            })
            .collect();

        let selected = select_startable_jobs(&queued_jobs, &[], 1_000);

        assert_eq!(selected.len(), MAX_ACTIVE_AGENT_JOBS_PER_USER);
        assert_eq!(selected[0], "job-0");
        assert_eq!(selected[7], "job-7");
    }

    #[test]
    fn scheduler_keeps_user_limits_independent() {
        let running_jobs: Vec<_> = (0..MAX_ACTIVE_AGENT_JOBS_PER_USER)
            .map(|index| {
                running(
                    &format!("running-{index}"),
                    "user-a",
                    &format!("chat-a-{index}"),
                )
            })
            .collect();
        let queued_jobs = vec![
            queued("job-a", "user-a", "chat-a-extra", 1_000),
            queued("job-b", "user-b", "chat-b", 1_001),
        ];

        let selected = select_startable_jobs(&queued_jobs, &running_jobs, 2_000);

        assert_eq!(selected, vec!["job-b".to_string()]);
    }

    #[test]
    fn scheduler_preserves_fifo_for_same_chat() {
        let running_jobs = vec![running("running-a", "user-a", "chat-a")];
        let queued_jobs = vec![
            queued("job-a-later", "user-a", "chat-a", 1_000),
            queued("job-b", "user-a", "chat-b", 1_001),
        ];

        let selected = select_startable_jobs(&queued_jobs, &running_jobs, 2_000);

        assert_eq!(selected, vec!["job-b".to_string()]);
    }

    #[test]
    fn scheduler_allows_different_chats_for_same_user_under_limit() {
        let running_jobs = vec![running("running-a", "user-a", "chat-a")];
        let queued_jobs = vec![queued("job-b", "user-a", "chat-b", 1_000)];

        let selected = select_startable_jobs(&queued_jobs, &running_jobs, 2_000);

        assert_eq!(selected, vec!["job-b".to_string()]);
    }
}
