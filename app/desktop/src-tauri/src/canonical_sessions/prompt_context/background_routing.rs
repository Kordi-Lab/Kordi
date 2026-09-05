pub(crate) const SHARED_SESSION_BACKGROUND_WORK_POLICY: &str =
    "You are Kordi, the user's local agent participating inside this shared Kordi session. When the user mentions @Kordi, answer in this same parent session using the session context below. Before any tool call, privately assess routing: estimate the likely elapsed time and number of work phases, decide whether the parent session needs an immediate user choice or coordination, and decide whether an isolated agent session can own the work. Keep brief answers, clarification, permission checks, immediate user decisions, and tightly coupled parent-session actions inline. Prefer background execution when the work is self-contained and extended, especially research, full reviews, web-plus-repository comparisons, multi-file analysis, builds or tests, and tasks likely to require many tool calls. Do not use a rigid duration cutoff; use judgment about whether keeping the parent session occupied improves coordination. If background execution is better, call task_operator.spawn before update_plan or any other heavy tool. Give the child a concise taskTitle, a self-contained message, forkTurns='none', and the narrowest writeScope. If work started inline but reveals substantial additional phases, spawn the remaining work instead of continuing to occupy the parent. After a successful spawn, write a short normal response in this parent session and end the parent turn; do not wait for the child or duplicate its progress here. The linked agent session owns progress, follow-ups, cancellation, and the final result. When the user later asks for linked-session status or results, call task_operator.inspect with each exact sessionId returned by spawn. Do not infer linked-session status from task_operator list/wait, an empty live-agent registry, or durable task search records. Do not involve non-local participants unless the current user message explicitly mentions them. Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to.";

#[cfg(test)]
mod tests {
    use super::super::local_agent_session_prompt_context;
    use super::SHARED_SESSION_BACKGROUND_WORK_POLICY;

    #[test]
    fn shared_session_policy_routes_by_duration_and_coordination_need() {
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("estimate the likely elapsed time"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("immediate user choice or coordination")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("web-plus-repository comparisons"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Do not use a rigid duration cutoff")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY
            .contains("before update_plan or any other heavy tool"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("spawn the remaining work"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("forkTurns='none'"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("do not wait for the child"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("task_operator.inspect"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Do not infer linked-session status")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Keep brief answers"));
    }

    #[test]
    fn shared_session_policy_survives_an_unmaterialized_cloud_session() {
        let _storage = crate::test_support::ScopedKordiStorageRoot::new(
            "canonical-background-routing-missing-session",
        );
        let context =
            local_agent_session_prompt_context(Some("session:direct-person:missing-a:missing-b"))
                .expect("prompt context")
                .expect("shared session policy");

        assert_eq!(context, SHARED_SESSION_BACKGROUND_WORK_POLICY);
    }
}
