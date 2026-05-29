#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudToolCapability {
    SandboxLocal,
    OwnerLocal,
    OtherUserData,
    UnsyncedPrivateResource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudToolDecision {
    AllowSandbox,
    Block { reason: &'static str },
}

pub fn decide_cloud_tool_capability(capability: CloudToolCapability) -> CloudToolDecision {
    match capability {
        CloudToolCapability::SandboxLocal => CloudToolDecision::AllowSandbox,
        CloudToolCapability::OwnerLocal => CloudToolDecision::Block {
            reason: "This action requires the owner's local device, which is offline. I can work in the Cloud sandbox instead.",
        },
        CloudToolCapability::OtherUserData => CloudToolDecision::Block {
            reason: "This action would cross into another user's data, so it is not available from the Cloud sandbox.",
        },
        CloudToolCapability::UnsyncedPrivateResource => CloudToolDecision::Block {
            reason: "This resource has not been synced or explicitly made available to Cloud fallback.",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_local_actions_are_allowed_without_prompting() {
        assert_eq!(
            decide_cloud_tool_capability(CloudToolCapability::SandboxLocal),
            CloudToolDecision::AllowSandbox,
        );
    }

    #[test]
    fn owner_local_actions_are_blocked_with_runtime_boundary() {
        assert!(matches!(
            decide_cloud_tool_capability(CloudToolCapability::OwnerLocal),
            CloudToolDecision::Block { reason }
                if reason.contains("owner's local device") && reason.contains("Cloud sandbox")
        ));
    }
}
