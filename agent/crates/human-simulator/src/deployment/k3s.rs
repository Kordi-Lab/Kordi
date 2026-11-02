use super::{Operation, contains, summary};
use crate::{
    client::required_env,
    deployment_config::{Backend, DeploymentConfig},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

#[cfg(all(test, unix))]
#[path = "k3s_tests.rs"]
mod tests;

struct Kubectl {
    program: std::path::PathBuf,
    kubeconfig: String,
    context: String,
    namespace: String,
}
impl Kubectl {
    async fn call(&self, args: &[&str], body: Option<&Value>) -> Result<Value> {
        let mut command = Command::new(&self.program);
        command
            .args([
                "--kubeconfig",
                &self.kubeconfig,
                "--context",
                &self.context,
                "--namespace",
                &self.namespace,
                "--request-timeout=30s",
            ])
            .args(args)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| anyhow::anyhow!("Cannot start kubectl"))?;
        let input = body.map(serde_json::to_vec).transpose()?;
        let operation = async move {
            if let Some(mut stdin) = child.stdin.take() {
                if let Some(input) = input {
                    stdin
                        .write_all(&input)
                        .await
                        .context("Cannot write Kubernetes request")?;
                }
                drop(stdin);
            }
            let output = child
                .wait_with_output()
                .await
                .context("kubectl did not complete")?;
            ensure!(
                output.status.success(),
                "Kubernetes operation failed; inspect worker-status before retrying"
            );
            ensure!(
                output.stdout.len() <= 2 * 1024 * 1024,
                "Kubernetes response exceeds limit"
            );
            if output.stdout.is_empty() {
                return Ok(Value::Null);
            };
            serde_json::from_slice(&output.stdout)
                .map_err(|_| anyhow::anyhow!("Invalid Kubernetes response"))
        };
        tokio::time::timeout(Duration::from_secs(40), operation)
            .await
            .context("Kubernetes operation timed out; inspect worker-status")?
    }
    async fn find(&self, config: &DeploymentConfig) -> Result<Option<Value>> {
        let job = self
            .call(
                &[
                    "get",
                    "job",
                    &config.identity(),
                    "--ignore-not-found",
                    "-o",
                    "json",
                ],
                None,
            )
            .await?;
        if job.is_null() {
            return Ok(None);
        };
        verify(config, &job)?;
        Ok(Some(job))
    }

    async fn pods_stopped(&self, job: &Value) -> Result<bool> {
        let uid = job["metadata"]["uid"]
            .as_str()
            .context("Kubernetes Job has no UID")?;
        ensure!(
            !uid.is_empty()
                && uid.len() <= 128
                && uid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "Invalid Kubernetes Job UID"
        );
        let selector = format!("batch.kubernetes.io/controller-uid={uid}");
        let pods = self
            .call(
                &["get", "pods", "--selector", &selector, "-o", "json"],
                None,
            )
            .await?;
        let pods = pods["items"]
            .as_array()
            .context("Invalid Kubernetes Pod list")?;
        Ok(pods.iter().all(|pod| {
            matches!(
                pod["status"]["phase"].as_str(),
                Some("Succeeded" | "Failed")
            )
        }))
    }
}
fn empty(v: &Value) -> bool {
    v.is_null() || v.as_array().is_some_and(Vec::is_empty)
}
fn verify(config: &DeploymentConfig, job: &Value) -> Result<()> {
    let expected = config.manifest();
    ensure!(
        contains(&job["metadata"], &expected["metadata"])
            && contains(&job["spec"], &expected["spec"]),
        "Existing Kubernetes Job does not match this deployment; no changes made"
    );
    let pod = &job["spec"]["template"]["spec"];
    for key in ["hostNetwork", "hostPID", "hostIPC"] {
        ensure!(
            pod[key].is_null() || pod[key] == false,
            "Kubernetes Job has unexpected host access"
        );
    }
    for key in [
        "activeDeadlineSeconds",
        "ttlSecondsAfterFinished",
        "podFailurePolicy",
        "successPolicy",
    ] {
        ensure!(
            job["spec"][key].is_null(),
            "Kubernetes Job has unexpected lifecycle configuration"
        );
    }
    for key in ["parallelism", "completions"] {
        ensure!(
            job["spec"][key].is_null() || job["spec"][key] == 1,
            "Kubernetes Job has unexpected concurrency"
        );
    }
    ensure!(
        job["spec"]["manualSelector"].is_null() || job["spec"]["manualSelector"] == false,
        "Kubernetes Job has unexpected selector ownership"
    );
    for key in ["initContainers", "ephemeralContainers", "volumes"] {
        ensure!(
            empty(&pod[key]),
            "Kubernetes Job has unexpected pod configuration"
        );
    }
    let worker = &pod["containers"][0];
    let security = &worker["securityContext"];
    ensure!(
        security["privileged"].is_null() || security["privileged"] == false,
        "Kubernetes worker is unexpectedly privileged"
    );
    ensure!(
        security["procMount"].is_null() || security["procMount"] == "Default",
        "Kubernetes worker has unexpected proc access"
    );
    ensure!(
        empty(&security["capabilities"]["add"]),
        "Kubernetes worker has extra capabilities"
    );
    for key in ["envFrom", "volumeMounts", "command", "ports", "lifecycle"] {
        ensure!(
            empty(&worker[key]),
            "Kubernetes Job has unexpected worker configuration"
        );
    }
    ensure!(
        worker["env"] == expected["spec"]["template"]["spec"]["containers"][0]["env"],
        "Kubernetes Job has unexpected environment"
    );
    Ok(())
}
fn condition(job: &Value, name: &str) -> bool {
    job["status"]["conditions"]
        .as_array()
        .is_some_and(|values| {
            values
                .iter()
                .any(|v| v["type"] == name && v["status"] == "True")
        })
}
fn state(job: &Value) -> &str {
    if condition(job, "Complete") {
        "completed"
    } else if condition(job, "Failed") {
        "failed"
    } else if job["spec"]["suspend"] == true {
        if job["status"]["active"].as_u64().unwrap_or(0) == 0 && condition(job, "Suspended") {
            "stopped"
        } else {
            "stopping"
        }
    } else if job["status"]["active"].as_u64().unwrap_or(0) > 0 {
        "running"
    } else {
        "pending"
    }
}
async fn suspend(
    kube: &Kubectl,
    config: &DeploymentConfig,
    job: &Value,
    suspend: bool,
) -> Result<Value> {
    let uid = job["metadata"]["uid"]
        .as_str()
        .context("Kubernetes Job has no UID")?;
    let revision = job["metadata"]["resourceVersion"]
        .as_str()
        .context("Kubernetes Job has no resource version")?;
    let patch = json!([
        {"op":"test","path":"/metadata/uid","value":uid},
        {"op":"test","path":"/metadata/resourceVersion","value":revision},
        {"op":"add","path":"/spec/suspend","value":suspend}
    ]);
    let result = kube
        .call(
            &[
                "patch",
                "job",
                &config.identity(),
                "--type=json",
                "--patch-file=/dev/stdin",
                "-o",
                "json",
            ],
            Some(&patch),
        )
        .await?;
    verify(config, &result)?;
    Ok(result)
}

pub(super) async fn execute(config: &DeploymentConfig, operation: Operation) -> Result<Value> {
    let Backend::K3s {
        context, namespace, ..
    } = &config.backend
    else {
        bail!("Expected k3s deployment")
    };
    let kubeconfig = required_env("KUBECONFIG")?;
    ensure!(
        std::fs::metadata(&kubeconfig).is_ok_and(|m| m.is_file()),
        "KUBECONFIG must name one readable configuration file"
    );
    let kube = Kubectl {
        program: "kubectl".into(),
        kubeconfig,
        context: context.clone(),
        namespace: namespace.clone(),
    };
    execute_with(&kube, config, operation).await
}
async fn execute_with(
    kube: &Kubectl,
    config: &DeploymentConfig,
    operation: Operation,
) -> Result<Value> {
    let existing = kube.find(config).await?;
    match operation {
        Operation::Status => {
            let mut value = existing.as_ref().map_or("absent", state);
            if let Some(job) = &existing
                && value == "stopped"
                && !kube.pods_stopped(job).await?
            {
                value = "stopping";
            }
            Ok(summary("k3s", value))
        }
        Operation::Deploy => {
            let job = if let Some(job) = existing {
                if job["spec"]["suspend"] == true
                    && !condition(&job, "Complete")
                    && !condition(&job, "Failed")
                {
                    suspend(kube, config, &job, false).await?
                } else {
                    job
                }
            } else {
                // Create, never apply over an unknown resource. On an ambiguous
                // result, the next invocation reconciles the deterministic name.
                let job = kube
                    .call(
                        &["create", "-f", "-", "-o", "json"],
                        Some(&config.manifest()),
                    )
                    .await?;
                verify(config, &job)?;
                job
            };
            Ok(summary("k3s", state(&job)))
        }
        Operation::Stop => {
            let Some(job) = existing else {
                return Ok(summary("k3s", "absent"));
            };
            if matches!(state(&job), "completed" | "failed")
                || (state(&job) == "stopped" && kube.pods_stopped(&job).await?)
            {
                return Ok(summary("k3s", state(&job)));
            };
            suspend(kube, config, &job, true).await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(50);
            loop {
                let Some(job) = kube.find(config).await? else {
                    return Ok(summary("k3s", "absent"));
                };
                if matches!(state(&job), "completed" | "failed")
                    || (state(&job) == "stopped" && kube.pods_stopped(&job).await?)
                {
                    return Ok(summary("k3s", state(&job)));
                };
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "Kubernetes worker is still stopping; inspect worker-status"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
