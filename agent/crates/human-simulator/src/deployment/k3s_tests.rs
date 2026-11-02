use super::*;
use crate::deployment_config::{AccountAuth, Backend, DeploymentConfig};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use uuid::Uuid;

struct FakeKubectl {
    directory: PathBuf,
    state_path: PathBuf,
    log_path: PathBuf,
}

impl FakeKubectl {
    fn new(initial_job: Option<Value>) -> Self {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!("kordi-k3s-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).expect("create fake kubectl directory");
        let program = directory.join("kubectl");
        let state_path = directory.join("state.json");
        let log_path = directory.join("calls.json");
        fs::write(
            &state_path,
            serde_json::to_vec(&json!({"job": initial_job})).unwrap(),
        )
        .expect("write fake kubectl state");
        fs::write(&log_path, b"[]").expect("write fake kubectl log");

        let script = r##"#!/usr/bin/env python3
import json
import sys
from pathlib import Path

state_path = Path(__STATE_PATH__)
log_path = Path(__LOG_PATH__)
state = json.loads(state_path.read_text())
args = sys.argv[1:]
body_text = sys.stdin.read()
body = json.loads(body_text) if body_text else None
calls = json.loads(log_path.read_text())
calls.append({"args": args, "body": body})
log_path.write_text(json.dumps(calls))

command_index = args.index("--request-timeout=30s") + 1
command = args[command_index]
if command == "get":
    response = {"items": state.get("pods", [])} if args[command_index + 1] == "pods" else state["job"]
elif command == "create":
    job = body
    job.setdefault("metadata", {})["uid"] = "synthetic-job-uid"
    job["metadata"]["resourceVersion"] = "1"
    job["status"] = {"active": 1, "conditions": []}
    state["job"] = job
    response = job
elif command == "patch":
    job = state["job"]
    assert job is not None
    patch = body
    assert patch[0] == {"op": "test", "path": "/metadata/uid", "value": "synthetic-job-uid"}
    assert patch[1] == {"op": "test", "path": "/metadata/resourceVersion", "value": job["metadata"]["resourceVersion"]}
    job["spec"]["suspend"] = patch[2]["value"]
    job["metadata"]["resourceVersion"] = str(int(job["metadata"]["resourceVersion"]) + 1)
    if patch[2]["value"]:
        job["status"] = {"active": 0, "conditions": [{"type": "Suspended", "status": "True"}]}
    else:
        job["status"] = {"active": 1, "conditions": []}
    state["job"] = job
    response = job
else:
    raise AssertionError("unexpected kubectl command")

state_path.write_text(json.dumps(state))
print(json.dumps(response))
"##;
        let script = script
            .replace(
                "__STATE_PATH__",
                &format!("{:?}", state_path.to_string_lossy()),
            )
            .replace("__LOG_PATH__", &format!("{:?}", log_path.to_string_lossy()));
        fs::write(&program, script).expect("write fake kubectl executable");
        let mut permissions = fs::metadata(&program)
            .expect("read fake kubectl metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&program, permissions).expect("make fake kubectl executable");

        Self {
            directory,
            state_path,
            log_path,
        }
    }

    fn kubectl(&self) -> Kubectl {
        Kubectl {
            program: self.directory.join("kubectl"),
            kubeconfig: self
                .directory
                .join("synthetic-kubeconfig")
                .display()
                .to_string(),
            context: "synthetic-context".into(),
            namespace: "synthetic-namespace".into(),
        }
    }

    fn calls(&self) -> Vec<Value> {
        serde_json::from_slice(&fs::read(&self.log_path).expect("read fake kubectl log"))
            .expect("parse fake kubectl log")
    }

    fn write_job(&self, job: &Value) {
        let mut state: Value =
            serde_json::from_slice(&fs::read(&self.state_path).expect("read fake kubectl state"))
                .expect("parse fake kubectl state");
        state["job"] = job.clone();
        fs::write(&self.state_path, serde_json::to_vec(&state).unwrap())
            .expect("update fake kubectl state");
    }
}

impl Drop for FakeKubectl {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
        let _ = fs::remove_file(&self.log_path);
    }
}

fn config() -> DeploymentConfig {
    DeploymentConfig {
        actor_id: "synthetic-actor-01".into(),
        image: format!(
            "registry.example.invalid/human-simulator/worker@sha256:{}",
            "a".repeat(64)
        ),
        api_base: "https://simulator.example.invalid/".into(),
        backend: Backend::K3s {
            context: "configured-context".into(),
            namespace: "configured-namespace".into(),
            worker_secret: "configured-worker-secret".into(),
            account_secret: "configured-account-secret".into(),
            account_auth: AccountAuth::Session,
        },
    }
}

fn existing_job(config: &DeploymentConfig, suspend: bool, active: u64) -> Value {
    let mut job = config.manifest();
    job["metadata"]["uid"] = json!("synthetic-job-uid");
    job["metadata"]["resourceVersion"] = json!("1");
    job["spec"]["suspend"] = json!(suspend);
    job["status"] = json!({
        "active": active,
        "conditions": if suspend && active == 0 {
            json!([{"type":"Suspended", "status":"True"}])
        } else {
            json!([])
        }
    });
    job
}

fn command(call: &Value) -> &str {
    let args = call["args"].as_array().expect("kubectl args");
    let timeout = args
        .iter()
        .position(|arg| arg == "--request-timeout=30s")
        .expect("explicit request timeout");
    args[timeout + 1].as_str().expect("kubectl command")
}

fn assert_explicit_target(calls: &[Value], kubeconfig: &str, context: &str, namespace: &str) {
    for call in calls {
        let args = call["args"].as_array().expect("kubectl args");
        assert_eq!(args[0], "--kubeconfig");
        assert_eq!(args[1], kubeconfig);
        assert_eq!(args[2], "--context");
        assert_eq!(args[3], context);
        assert_eq!(args[4], "--namespace");
        assert_eq!(args[5], namespace);
    }
}

#[tokio::test]
async fn deploy_uses_explicit_target_and_reconciles_without_duplicate_create() {
    let config = config();
    config.validate().unwrap();
    let fake = FakeKubectl::new(None);
    let kube = fake.kubectl();

    let first = execute_with(&kube, &config, Operation::Deploy)
        .await
        .unwrap();
    assert_eq!(first["worker_state"], "running");
    let second = execute_with(&kube, &config, Operation::Deploy)
        .await
        .unwrap();
    assert_eq!(second["worker_state"], "running");

    let calls = fake.calls();
    assert_eq!(
        calls.iter().map(command).collect::<Vec<_>>(),
        vec!["get", "create", "get"]
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| command(call) == "create")
            .count(),
        1
    );
    assert_explicit_target(&calls, &kube.kubeconfig, &kube.context, &kube.namespace);
    assert_eq!(calls[1]["body"]["metadata"]["name"], config.identity());
}

#[tokio::test]
async fn ownership_mismatch_refuses_deploy_and_stop_without_mutations() {
    let config = config();
    let fake = FakeKubectl::new(Some(existing_job(&config, false, 1)));
    let mut mismatched = existing_job(&config, false, 1);
    mismatched["metadata"]["annotations"]["kordi.cloud/simulator-actor"] = json!("another-actor");
    fake.write_job(&mismatched);
    let kube = fake.kubectl();

    assert!(
        execute_with(&kube, &config, Operation::Deploy)
            .await
            .is_err()
    );
    assert!(execute_with(&kube, &config, Operation::Stop).await.is_err());

    let calls = fake.calls();
    assert!(calls.iter().all(|call| command(call) == "get"));
}

#[tokio::test]
async fn stop_patches_uid_and_resource_version_then_waits_for_suspended_condition() {
    let config = config();
    let fake = FakeKubectl::new(Some(existing_job(&config, false, 1)));
    let kube = fake.kubectl();

    let result = execute_with(&kube, &config, Operation::Stop).await.unwrap();
    assert_eq!(result["worker_state"], "stopped");

    let calls = fake.calls();
    assert_eq!(
        calls.iter().map(command).collect::<Vec<_>>(),
        vec!["get", "patch", "get", "get"]
    );
    assert_explicit_target(&calls, &kube.kubeconfig, &kube.context, &kube.namespace);
    let patch = &calls[1]["body"];
    assert_eq!(patch[0]["op"], "test");
    assert_eq!(patch[0]["path"], "/metadata/uid");
    assert_eq!(patch[0]["value"], "synthetic-job-uid");
    assert_eq!(patch[1]["op"], "test");
    assert_eq!(patch[1]["path"], "/metadata/resourceVersion");
    assert_eq!(patch[1]["value"], "1");
    assert_eq!(patch[2]["op"], "add");
    assert_eq!(patch[2]["path"], "/spec/suspend");
    assert_eq!(patch[2]["value"], true);
}

#[test]
fn rejects_extra_privilege_and_lifecycle_changes() {
    let config = config();
    for (path, value) in [
        ("/spec/template/spec/hostNetwork", json!(true)),
        ("/spec/template/spec/hostPID", json!(true)),
        (
            "/spec/template/spec/containers/0/securityContext/privileged",
            json!(true),
        ),
        (
            "/spec/template/spec/containers/0/securityContext/procMount",
            json!("Unmasked"),
        ),
        (
            "/spec/template/spec/containers/0/securityContext/capabilities/add",
            json!(["SYS_ADMIN"]),
        ),
        ("/spec/ttlSecondsAfterFinished", json!(10)),
        ("/spec/parallelism", json!(2)),
    ] {
        let mut job = existing_job(&config, false, 1);
        let (parent, key) = path.rsplit_once('/').unwrap();
        job.pointer_mut(parent).unwrap()[key] = value;
        assert!(
            verify(&config, &job).is_err(),
            "accepted extra runtime field"
        );
    }
}

#[tokio::test]
async fn stop_treats_suspended_condition_as_stopped_only_when_no_job_is_active() {
    let config = config();
    let mut job = existing_job(&config, true, 0);
    assert_eq!(state(&job), "stopped");

    job["status"]["active"] = json!(1);
    assert_eq!(state(&job), "stopping");

    job["status"]["active"] = json!(0);
    job["status"]["conditions"] = json!([]);
    assert_eq!(state(&job), "stopping");

    let fake = FakeKubectl::new(Some(job));
    let kube = fake.kubectl();
    let result = execute_with(&kube, &config, Operation::Stop).await.unwrap();
    assert_eq!(result["worker_state"], "stopped");
    let calls = fake.calls();
    assert_eq!(
        calls.iter().map(command).collect::<Vec<_>>(),
        vec!["get", "patch", "get", "get"]
    );
}

#[tokio::test]
async fn deploy_resumes_suspended_job_but_does_not_patch_active_job() {
    let config = config();
    let fake = FakeKubectl::new(Some(existing_job(&config, true, 0)));
    let kube = fake.kubectl();

    let result = execute_with(&kube, &config, Operation::Deploy)
        .await
        .unwrap();
    assert_eq!(result["worker_state"], "running");

    let calls = fake.calls();
    assert_eq!(
        calls.iter().map(command).collect::<Vec<_>>(),
        vec!["get", "patch"]
    );
    let patch = &calls[1]["body"];
    assert_eq!(patch[0]["path"], "/metadata/uid");
    assert_eq!(patch[1]["path"], "/metadata/resourceVersion");
    assert_eq!(patch[2]["path"], "/spec/suspend");
    assert_eq!(patch[2]["value"], false);

    let active_fake = FakeKubectl::new(Some(existing_job(&config, false, 1)));
    let active_result = execute_with(&active_fake.kubectl(), &config, Operation::Deploy)
        .await
        .unwrap();
    assert_eq!(active_result["worker_state"], "running");
    assert!(
        active_fake
            .calls()
            .iter()
            .all(|call| command(call) == "get")
    );

    for (condition, expected_state) in [("Complete", "completed"), ("Failed", "failed")] {
        let mut terminal_job = existing_job(&config, true, 0);
        terminal_job["status"]["conditions"] = json!([{ "type": condition, "status": "True" }]);
        let terminal_fake = FakeKubectl::new(Some(terminal_job));
        let terminal_result = execute_with(&terminal_fake.kubectl(), &config, Operation::Deploy)
            .await
            .unwrap();
        assert_eq!(terminal_result["worker_state"], expected_state);
        assert!(
            terminal_fake
                .calls()
                .iter()
                .all(|call| command(call) == "get")
        );
    }
}

#[tokio::test]
async fn status_does_not_report_stopped_while_a_pod_is_terminating() {
    let config = config();
    let fake = FakeKubectl::new(Some(existing_job(&config, true, 0)));
    let mut stored: Value = serde_json::from_slice(&fs::read(&fake.state_path).unwrap()).unwrap();
    stored["pods"] =
        json!([{"metadata":{"deletionTimestamp":"synthetic"},"status":{"phase":"Running"}}]);
    fs::write(&fake.state_path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let result = execute_with(&fake.kubectl(), &config, Operation::Status)
        .await
        .unwrap();
    assert_eq!(result["worker_state"], "stopping");
    assert!(fake.calls().iter().all(|call| command(call) == "get"));
}
