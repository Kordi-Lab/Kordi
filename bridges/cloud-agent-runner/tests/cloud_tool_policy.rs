use kordi_cloud_agent_runner::sandbox_client::LocalSandboxBackend;
use kordi_cloud_agent_runner::tool_policy::{
    decide_runner_tool, RunnerToolBlockReason, RunnerToolDecision, RunnerToolRequest,
};
use std::fs;

fn ctx_request(tool_name: &str) -> RunnerToolRequest<'_> {
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
fn policy_allows_sandbox_local_path_tools() {
    for tool_name in ["read", "write", "edit", "find", "grep", "ls", "bash"] {
        let request = RunnerToolRequest {
            path_args: vec!["workspace/notes.md"],
            ..ctx_request(tool_name)
        };

        assert_eq!(
            decide_runner_tool(&request),
            RunnerToolDecision::AllowSandbox
        );
    }
}

#[test]
fn policy_blocks_owner_local_and_traversal_paths() {
    for path in [
        "/Users/owner/private.txt",
        "/home/owner/.ssh/id_ed25519",
        "~/Desktop/private.txt",
    ] {
        let request = RunnerToolRequest {
            path_args: vec![path],
            ..ctx_request("read")
        };

        assert_eq!(
            decide_runner_tool(&request),
            RunnerToolDecision::Block(RunnerToolBlockReason::OwnerLocalResource)
        );
    }

    for path in ["../outside.txt", "workspace/../../outside.txt"] {
        let request = RunnerToolRequest {
            path_args: vec![path],
            ..ctx_request("write")
        };

        assert_eq!(
            decide_runner_tool(&request),
            RunnerToolDecision::Block(RunnerToolBlockReason::PathEscapesSandbox)
        );
    }
}

#[test]
fn policy_allows_public_remote_web_but_blocks_private_networks() {
    let public = RunnerToolRequest {
        url_args: vec!["https://example.com/docs"],
        ..ctx_request("web_fetch")
    };
    assert_eq!(
        decide_runner_tool(&public),
        RunnerToolDecision::AllowRemoteWeb
    );

    for url in [
        "http://localhost:3000",
        "http://127.0.0.1:8080",
        "http://10.0.0.5/api",
        "http://192.168.1.2",
        "http://172.20.0.1/service",
        "http://[::1]:3000",
    ] {
        let private = RunnerToolRequest {
            url_args: vec![url],
            ..ctx_request("browser_fetch")
        };

        assert_eq!(
            decide_runner_tool(&private),
            RunnerToolDecision::Block(RunnerToolBlockReason::PrivateNetwork)
        );
    }
}

#[test]
fn web_fetch_private_url_is_blocked_in_cloud_runner() {
    let request = RunnerToolRequest {
        tool_name: "web_fetch",
        path_args: Vec::new(),
        url_args: vec!["http://127.0.0.1:1420/private"],
        requester_account_id: "acct_requester",
        owner_account_id: "acct_owner",
        data_owner_account_id: None,
    };

    assert_eq!(
        decide_runner_tool(&request),
        RunnerToolDecision::Block(RunnerToolBlockReason::PrivateNetwork)
    );
}

#[test]
fn policy_blocks_unsupported_tools_and_other_user_data() {
    let outreach = ctx_request("reach_out");
    assert_eq!(
        decide_runner_tool(&outreach),
        RunnerToolDecision::Block(RunnerToolBlockReason::UnsupportedTool)
    );

    let other_user = RunnerToolRequest {
        data_owner_account_id: Some("acct_other"),
        ..ctx_request("read")
    };
    assert_eq!(
        decide_runner_tool(&other_user),
        RunnerToolDecision::Block(RunnerToolBlockReason::OtherUserData)
    );
}

#[tokio::test]
async fn local_sandbox_backend_executes_only_inside_root() {
    let root = std::env::temp_dir().join(format!(
        "kordi-runner-sandbox-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).unwrap();
    let backend = LocalSandboxBackend::new(root.clone());

    backend
        .write_text("notes/plan.md", "hello sandbox")
        .await
        .unwrap();
    assert_eq!(
        backend.read_text("notes/plan.md").await.unwrap(),
        "hello sandbox"
    );
    assert_eq!(
        backend.list("notes").await.unwrap(),
        vec!["plan.md".to_string()]
    );

    let output = backend
        .run_bash("printf 'from bash' > notes/bash.txt")
        .await
        .unwrap();
    assert_eq!(output.exit_code, 0);
    assert_eq!(
        backend.read_text("notes/bash.txt").await.unwrap(),
        "from bash"
    );

    assert!(backend.read_text("../outside.txt").await.is_err());
    assert!(backend
        .write_text("/Users/owner/private.txt", "nope")
        .await
        .is_err());
    assert!(backend
        .run_bash("printf nope > /tmp/kordi-cloud-runner-outside.txt")
        .await
        .is_err());

    let _ = fs::remove_dir_all(root);
}
