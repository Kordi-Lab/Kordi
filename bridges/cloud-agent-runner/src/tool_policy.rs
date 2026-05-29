#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerToolDecision {
    AllowSandbox,
    AllowRemoteWeb,
    Block(RunnerToolBlockReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerToolBlockReason {
    OwnerLocalResource,
    PathEscapesSandbox,
    PrivateNetwork,
    OtherUserData,
    UnsupportedTool,
}

impl RunnerToolBlockReason {
    pub fn explanation(self) -> &'static str {
        match self {
            Self::OwnerLocalResource => {
                "Cloud fallback cannot access the owner's local device while it is offline. I can use the Cloud sandbox instead."
            }
            Self::PathEscapesSandbox => {
                "Cloud fallback can only access files inside its isolated Cloud sandbox."
            }
            Self::PrivateNetwork => {
                "Cloud fallback cannot access localhost or private-network resources from the owner's environment."
            }
            Self::OtherUserData => {
                "Cloud fallback cannot access data belonging to another user."
            }
            Self::UnsupportedTool => {
                "This tool is not available in Cloud fallback until a safe remote implementation exists."
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerToolRequest<'a> {
    pub tool_name: &'a str,
    pub path_args: Vec<&'a str>,
    pub url_args: Vec<&'a str>,
    pub requester_account_id: &'a str,
    pub owner_account_id: &'a str,
    pub data_owner_account_id: Option<&'a str>,
}

pub fn decide_runner_tool(request: &RunnerToolRequest<'_>) -> RunnerToolDecision {
    if let Some(data_owner) = request.data_owner_account_id {
        if data_owner != request.owner_account_id && data_owner != request.requester_account_id {
            return RunnerToolDecision::Block(RunnerToolBlockReason::OtherUserData);
        }
    }

    match request.tool_name {
        "read" | "write" | "edit" | "find" | "grep" | "ls" | "bash" => {
            decide_sandbox_paths(&request.path_args)
        }
        "web_search" | "web_fetch" | "browser_fetch" => decide_web_urls(&request.url_args),
        "reach_out" | "reflection" | "update_plan" | "task_operator" => {
            RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
        }
        _ => RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool),
    }
}

fn decide_sandbox_paths(paths: &[&str]) -> RunnerToolDecision {
    for path in paths {
        let trimmed = path.trim();
        if is_owner_local_path(trimmed) {
            return RunnerToolDecision::Block(RunnerToolBlockReason::OwnerLocalResource);
        }
        if escapes_sandbox(trimmed) {
            return RunnerToolDecision::Block(RunnerToolBlockReason::PathEscapesSandbox);
        }
    }
    RunnerToolDecision::AllowSandbox
}

fn decide_web_urls(urls: &[&str]) -> RunnerToolDecision {
    for url in urls {
        if is_private_network_url(url) {
            return RunnerToolDecision::Block(RunnerToolBlockReason::PrivateNetwork);
        }
    }
    RunnerToolDecision::AllowRemoteWeb
}

pub fn is_owner_local_path(path: &str) -> bool {
    path == "~"
        || path.starts_with("~/")
        || path.starts_with("/Users/")
        || path.starts_with("/home/")
}

pub fn escapes_sandbox(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.starts_with('/') {
        return true;
    }
    std::path::Path::new(path)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

pub fn is_private_network_url(url: &str) -> bool {
    let value = url.trim().to_ascii_lowercase();
    if value.starts_with("file:") {
        return true;
    }
    let Some(hostish) = value.split_once("://").map(|(_, rest)| rest) else {
        return false;
    };
    let host_port = hostish
        .split('/')
        .next()
        .unwrap_or_default()
        .split('@')
        .next_back()
        .unwrap_or_default();
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next().unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or_default()
    };

    host == "localhost"
        || host == "0.0.0.0"
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || is_172_private(host)
}

fn is_172_private(host: &str) -> bool {
    let Some(rest) = host.strip_prefix("172.") else {
        return false;
    };
    let Some(second) = rest
        .split('.')
        .next()
        .and_then(|value| value.parse::<u8>().ok())
    else {
        return false;
    };
    (16..=31).contains(&second)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tool_name: &str) -> RunnerToolRequest<'_> {
        RunnerToolRequest {
            tool_name,
            path_args: Vec::new(),
            url_args: Vec::new(),
            requester_account_id: "acct_requester",
            owner_account_id: "acct_owner",
            data_owner_account_id: None,
        }
    }

    #[test]
    fn blocked_reasons_have_runtime_boundary_explanations() {
        for reason in [
            RunnerToolBlockReason::OwnerLocalResource,
            RunnerToolBlockReason::PathEscapesSandbox,
            RunnerToolBlockReason::PrivateNetwork,
            RunnerToolBlockReason::OtherUserData,
            RunnerToolBlockReason::UnsupportedTool,
        ] {
            let explanation = reason.explanation();
            assert!(explanation.contains("Cloud fallback"));
            assert!(!explanation.contains("approval"));
        }
    }

    #[test]
    fn web_search_without_url_is_allowed_remotely() {
        assert_eq!(
            decide_runner_tool(&request("web_search")),
            RunnerToolDecision::AllowRemoteWeb
        );
    }
}
