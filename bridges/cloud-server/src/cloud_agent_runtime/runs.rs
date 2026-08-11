mod authorization;
mod claims;
mod completion;
mod delivery;
mod envelopes;
mod errors;
mod group_mentions;
mod leases;
mod prompt_history;

pub use authorization::{
    claim_has_shared_cloud_agent_target, requester_can_target_owner,
    validate_agent_authored_group_handoff_claim, validate_shared_cloud_agent_claim,
};
pub use claims::{
    claim_run, lookup_run_for_request, AgentRuntimeRoute, ClaimRunRequest,
    CloudAgentRunLookupResponse, CloudAgentRunResponse,
};
pub use completion::{complete_run, fail_run, CompleteRunRequest, FailRunRequest};
#[cfg(test)]
use delivery::{
    cloud_group_response_recipients, direct_person_peer_account_id, is_scheduled_run_request_id,
};
pub use envelopes::encode_cloud_agent_response_body;
#[cfg(test)]
use envelopes::{
    cloud_group_response_body, parse_cloud_group_envelope, CloudGroupEnvelope, CloudGroupMessage,
    CloudGroupParticipant,
};
pub(crate) use errors::{error_response, run_error_response, runner_unauthorized};
pub use errors::{RunError, RunResult};
pub use leases::{
    lease_canary_run, lease_next_run, mark_run_running, RunnerLeaseResponse, RunnerRunEnvelope,
    RunnerRunRequest, RunnerRunResponse,
};
#[cfg(test)]
use prompt_history::{fallback_prompt_with_history, CloudFallbackHistoryMessage};

#[cfg(test)]
mod tests {
    use super::ClaimRunRequest;

    #[test]
    fn runner_request_accepts_optional_canary_run_id() {
        let request = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" car_canary ".to_string()),
        };
        assert_eq!(request.canary_run_id().as_deref(), Some("car_canary"));

        let empty = super::RunnerRunRequest {
            runner_id: "runner-a".to_string(),
            canary_run_id: Some(" ".to_string()),
        };
        assert_eq!(empty.canary_run_id(), None);
    }

    #[test]
    fn cloud_group_response_body_links_to_group_request() {
        let mut request = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:one".to_string(),
            group_space_id: Some("session:group:one".to_string()),
            group_title: None,
            created_by_account_id: "acct_requester".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_requester".to_string(),
                display_name: "Requester".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_requester".to_string(),
                    display_name: "Requester".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Owner".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
            ],
            message: Some(super::CloudGroupMessage {
                id: "msg:ui:request".to_string(),
                sender_account_id: "acct_requester".to_string(),
                text: "@OwnerKordi hello".to_string(),
                created_at_ms: 1,
                sender_kind: Some("human".to_string()),
                sender_display_name: None,
                delivery_state: None,
                reply_to_message_id: None,
                request_id: None,
                message_action: None,
                target_cloud_agent_id: None,
                target_cloud_agent_name: None,
                target_cloud_agent_owner_account_id: None,
                target_cloud_agent_owner_name: None,
                agent_mention_depth: None,
            }),
        };

        let body = super::cloud_group_response_body(
            &request,
            "acct_owner",
            "msg:ui:request",
            "cloudrunmsg_response",
            "@RequestersKordi Hello everyone!",
            "complete",
            2,
        );
        let response = super::parse_cloud_group_envelope(&body).expect("group response envelope");
        let message = response.message.expect("group response message");

        assert_eq!(response.kind, "group-message");
        assert_eq!(message.sender_account_id, "acct_owner");
        assert_eq!(message.sender_kind.as_deref(), Some("agent"));
        assert_eq!(
            message.sender_display_name.as_deref(),
            Some("Owner's Kordi")
        );
        assert_eq!(message.request_id.as_deref(), Some("msg:ui:request"));
        assert_eq!(message.delivery_state.as_deref(), Some("complete"));
        assert_eq!(message.text, "@RequestersKordi Hello everyone!");
        assert_eq!(
            message.target_cloud_agent_owner_account_id.as_deref(),
            Some("acct_requester")
        );
        assert_eq!(
            message.target_cloud_agent_owner_name.as_deref(),
            Some("Requester")
        );
        assert_eq!(message.agent_mention_depth, Some(1));

        request
            .message
            .as_mut()
            .expect("request message")
            .agent_mention_depth = Some(1);
        let chained_body = super::cloud_group_response_body(
            &request,
            "acct_owner",
            "msg:ui:request",
            "cloudrunmsg_chained_response",
            "@RequestersKordi ask again",
            "complete",
            3,
        );
        let chained_message = super::parse_cloud_group_envelope(&chained_body)
            .and_then(|envelope| envelope.message)
            .expect("chained group response message");
        assert_eq!(chained_message.target_cloud_agent_owner_account_id, None);
        assert_eq!(chained_message.agent_mention_depth, None);
    }

    #[test]
    fn shared_cloud_agent_group_response_uses_agent_owner_label() {
        let request = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:one".to_string(),
            group_space_id: Some("session:group:one".to_string()),
            group_title: None,
            created_by_account_id: "acct_requester".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_requester".to_string(),
                display_name: "Requester".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_requester".to_string(),
                    display_name: "Requester".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Shuyang".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
            ],
            message: Some(super::CloudGroupMessage {
                id: "msg:ui:request".to_string(),
                sender_account_id: "acct_requester".to_string(),
                text: "@ProjectDriver help".to_string(),
                created_at_ms: 1,
                sender_kind: Some("human".to_string()),
                sender_display_name: None,
                delivery_state: None,
                reply_to_message_id: None,
                request_id: None,
                message_action: None,
                target_cloud_agent_id: Some("cloud_agent_project".to_string()),
                target_cloud_agent_name: Some("Project Driver".to_string()),
                target_cloud_agent_owner_account_id: Some("acct_owner".to_string()),
                target_cloud_agent_owner_name: Some("Shuyang".to_string()),
                agent_mention_depth: None,
            }),
        };

        let body = super::cloud_group_response_body(
            &request,
            "acct_owner",
            "msg:ui:request",
            "cloudrunmsg_response",
            "@RequestersKordi please investigate.",
            "complete",
            2,
        );
        let response = super::parse_cloud_group_envelope(&body).expect("group response envelope");
        let message = response.message.expect("group response message");

        assert_eq!(
            message.sender_display_name.as_deref(),
            Some("Project Driver · Shuyang's Agent")
        );
        assert_eq!(
            message.target_cloud_agent_owner_account_id.as_deref(),
            Some("acct_requester")
        );
        assert_eq!(
            message.target_cloud_agent_owner_name.as_deref(),
            Some("Requester")
        );
        assert_eq!(message.target_cloud_agent_id, None);
        assert_eq!(message.target_cloud_agent_name, None);
        assert_eq!(message.agent_mention_depth, Some(1));
    }

    #[test]
    fn fallback_prompt_includes_prior_direct_chat_history() {
        let prompt = super::fallback_prompt_with_history(
            "acct_requester",
            "acct_owner",
            "check ahain",
            &[
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_requester".to_string(),
                    body: "@111sKordi what is xuzhu city weather".to_string(),
                },
                super::CloudFallbackHistoryMessage {
                    from_account_id: "acct_owner".to_string(),
                    body: super::encode_cloud_agent_response_body(
                        "msg_weather",
                        "I think you mean Xuzhou city, China.",
                    ),
                },
            ],
        );

        assert!(prompt.contains("Conversation history:\nRequester: what is xuzhu city weather"));
        assert!(prompt.contains("Owner's Kordi: I think you mean Xuzhou city, China."));
        assert!(prompt.ends_with("Current request:\ncheck ahain"));
    }

    #[test]
    fn scheduled_direct_person_peer_routes_to_the_contact_peer() {
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_a")
                .as_deref(),
            Some("acct_b")
        );
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_b")
                .as_deref(),
            Some("acct_a")
        );
        assert_eq!(
            super::direct_person_peer_account_id("session:direct-person:acct_a:acct_b", "acct_c"),
            None
        );
    }

    #[test]
    fn scheduled_run_request_ids_are_identified() {
        assert!(super::is_scheduled_run_request_id("scheduled_run_123"));
        assert!(!super::is_scheduled_run_request_id("msg_123"));
    }

    #[test]
    fn scheduled_group_response_recipients_include_owner_and_peer_participants() {
        let envelope = super::CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:scheduled".to_string(),
            group_space_id: Some("session:group:scheduled".to_string()),
            group_title: None,
            created_by_account_id: "acct_peer".to_string(),
            actor: super::CloudGroupParticipant {
                account_id: "acct_peer".to_string(),
                display_name: "Peer".to_string(),
                avatar_url: None,
                role: Some("admin".to_string()),
            },
            participants: vec![
                super::CloudGroupParticipant {
                    account_id: "acct_owner".to_string(),
                    display_name: "Owner".to_string(),
                    avatar_url: None,
                    role: Some("person".to_string()),
                },
                super::CloudGroupParticipant {
                    account_id: "acct_peer".to_string(),
                    display_name: "Peer".to_string(),
                    avatar_url: None,
                    role: Some("admin".to_string()),
                },
            ],
            message: None,
        };

        let recipients = super::cloud_group_response_recipients(&envelope);
        assert_eq!(recipients.len(), 2);
        assert!(recipients.contains("acct_owner"));
        assert!(recipients.contains("acct_peer"));
    }

    #[test]
    fn claim_request_rejects_empty_required_fields() {
        let valid = ClaimRunRequest {
            request_message_id: "msg_1".to_string(),
            session_id: "session:direct-person:a:b".to_string(),
            owner_account_id: "acct_owner".to_string(),
            requester_account_id: "acct_requester".to_string(),
            prompt: "@OwnerKordi hello".to_string(),
            runtime_route: None,
            idempotency_key: "session:msg:owner".to_string(),
        };
        assert!(valid.is_well_formed());

        let invalid = ClaimRunRequest {
            prompt: " ".to_string(),
            ..valid
        };
        assert!(!invalid.is_well_formed());
    }
}
