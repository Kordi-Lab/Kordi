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
