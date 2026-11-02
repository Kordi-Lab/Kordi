use std::net::IpAddr;

use anyhow::{Result, ensure};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const IDENTITY_HASH_HEX_CHARS: usize = 53;
const MAX_REFERENCE_CHARS: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeploymentConfig {
    pub actor_id: String,
    pub image: String,
    pub api_base: String,
    pub backend: Backend,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Backend {
    K3s {
        context: String,
        namespace: String,
        worker_secret: String,
        account_secret: String,
        account_auth: AccountAuth,
    },
    Fly {
        app: String,
        region: String,
        actor_token_secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_token_secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_email_secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_password_secret: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountAuth {
    Session,
    Login,
}

impl DeploymentConfig {
    pub fn validate(&self) -> Result<()> {
        validate_actor_id(&self.actor_id)?;
        validate_image(&self.image)?;
        validate_api_base(&self.api_base)?;

        match &self.backend {
            Backend::K3s {
                context,
                namespace,
                worker_secret,
                account_secret,
                ..
            } => {
                validate_reference(context, "k3s context")?;
                validate_dns_label(namespace, "k3s namespace")?;
                validate_dns_label(worker_secret, "k3s worker Secret name")?;
                validate_dns_label(account_secret, "k3s account Secret name")?;
            }
            Backend::Fly {
                app,
                region,
                actor_token_secret,
                account_token_secret,
                account_email_secret,
                account_password_secret,
            } => {
                validate_dns_label(app, "Fly app")?;
                validate_dns_label(region, "Fly region")?;
                validate_fly_secret_name(actor_token_secret, "Fly actor token Secret name")?;
                validate_optional_fly_secret_name(
                    account_token_secret.as_deref(),
                    "Fly account token Secret name",
                )?;
                validate_optional_fly_secret_name(
                    account_email_secret.as_deref(),
                    "Fly account email Secret name",
                )?;
                validate_optional_fly_secret_name(
                    account_password_secret.as_deref(),
                    "Fly account password Secret name",
                )?;

                let has_token = account_token_secret.is_some();
                let has_email = account_email_secret.is_some();
                let has_password = account_password_secret.is_some();
                ensure!(
                    (has_token && !has_email && !has_password)
                        || (!has_token && has_email && has_password),
                    "Fly account authentication must use one token Secret or both login Secrets"
                );
            }
        }
        Ok(())
    }

    /// Stable, actor-scoped runtime name shared by the deployment backends.
    pub fn identity(&self) -> String {
        let origin = Url::parse(&self.api_base)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| self.api_base.clone());
        let input = json!([origin, self.actor_id]).to_string();
        let digest = digest_hex(input.as_bytes());
        format!("human-sim-{}", &digest[..IDENTITY_HASH_HEX_CHARS])
    }

    /// SHA-256 of the normalized JSON form of the entire deployment config.
    pub fn fingerprint(&self) -> String {
        let value =
            serde_json::to_value(self).expect("DeploymentConfig contains only serializable values");
        let canonical_json =
            serde_json::to_vec(&value).expect("DeploymentConfig contains only serializable values");
        digest_hex(&canonical_json)
    }

    /// Produce a backend-specific create request without including secret values.
    pub fn manifest(&self) -> Value {
        match &self.backend {
            Backend::K3s {
                namespace,
                worker_secret,
                account_secret,
                account_auth,
                ..
            } => self.k3s_manifest(namespace, worker_secret, account_secret, *account_auth),
            Backend::Fly {
                region,
                actor_token_secret,
                account_token_secret,
                account_email_secret,
                account_password_secret,
                ..
            } => self.fly_manifest(
                region,
                actor_token_secret,
                account_token_secret.as_deref(),
                account_email_secret.as_deref(),
                account_password_secret.as_deref(),
            ),
        }
    }

    fn k3s_manifest(
        &self,
        namespace: &str,
        worker_secret: &str,
        account_secret: &str,
        account_auth: AccountAuth,
    ) -> Value {
        let mut env = vec![
            json!({"name":"KORDI_SIMULATOR_API_BASE","value":self.api_base}),
            secret_env(
                "KORDI_SIM_ACTOR_TOKEN",
                worker_secret,
                "KORDI_SIM_ACTOR_TOKEN",
            ),
        ];
        match account_auth {
            AccountAuth::Session => env.push(secret_env(
                "KORDI_SIM_ACCOUNT_TOKEN",
                account_secret,
                "KORDI_SIM_ACCOUNT_TOKEN",
            )),
            AccountAuth::Login => {
                env.push(secret_env(
                    "KORDI_SIM_ACCOUNT_EMAIL",
                    account_secret,
                    "KORDI_SIM_ACCOUNT_EMAIL",
                ));
                env.push(secret_env(
                    "KORDI_SIM_ACCOUNT_PASSWORD",
                    account_secret,
                    "KORDI_SIM_ACCOUNT_PASSWORD",
                ));
            }
        }

        let identity = self.identity();
        let fingerprint = self.fingerprint();
        json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": identity,
                "namespace": namespace,
                "labels": {
                    "app.kubernetes.io/name": "human-simulator-worker"
                },
                "annotations": {
                    "kordi.cloud/simulator-actor": self.actor_id,
                    "kordi.cloud/simulator-config": fingerprint
                }
            },
            "spec": {
                "backoffLimit": 6,
                "template": {
                    "metadata": {
                        "labels": {
                            "app.kubernetes.io/name": "human-simulator-worker"
                        },
                        "annotations": {
                            "kordi.cloud/simulator-actor": self.actor_id,
                            "kordi.cloud/simulator-config": fingerprint
                        }
                    },
                    "spec": {
                        "restartPolicy": "OnFailure",
                        "automountServiceAccountToken": false,
                        "terminationGracePeriodSeconds": 30,
                        "securityContext": {
                            "runAsNonRoot": true,
                            "runAsUser": 1000,
                            "runAsGroup": 1000,
                            "seccompProfile": {"type":"RuntimeDefault"}
                        },
                        "containers": [{
                            "name": "worker",
                            "image": self.image,
                            "imagePullPolicy": "IfNotPresent",
                            "args": ["run", "--actor", self.actor_id],
                            "env": env,
                            "securityContext": {
                                "runAsNonRoot": true,
                                "runAsUser": 1000,
                                "runAsGroup": 1000,
                                "allowPrivilegeEscalation": false,
                                "readOnlyRootFilesystem": true,
                                "capabilities": {"drop":["ALL"]}
                            },
                            "resources": {
                                "requests": {"cpu":"100m", "memory":"128Mi"},
                                "limits": {"cpu":"500m", "memory":"512Mi"}
                            }
                        }]
                    }
                }
            }
        })
    }

    fn fly_manifest(
        &self,
        region: &str,
        actor_token_secret: &str,
        account_token_secret: Option<&str>,
        account_email_secret: Option<&str>,
        account_password_secret: Option<&str>,
    ) -> Value {
        let mut secrets = vec![fly_secret("KORDI_SIM_ACTOR_TOKEN", actor_token_secret)];
        if let Some(secret) = account_token_secret {
            secrets.push(fly_secret("KORDI_SIM_ACCOUNT_TOKEN", secret));
        } else {
            if let Some(secret) = account_email_secret {
                secrets.push(fly_secret("KORDI_SIM_ACCOUNT_EMAIL", secret));
            }
            if let Some(secret) = account_password_secret {
                secrets.push(fly_secret("KORDI_SIM_ACCOUNT_PASSWORD", secret));
            }
        }

        json!({
            "name": self.identity(),
            "region": region,
            "skip_service_registration": true,
            "config": {
                "auto_destroy": false,
                "image": self.image,
                "services": [],
                "metadata": {
                    "kordi_simulator_actor": self.actor_id,
                    "kordi_simulator_config": self.fingerprint()
                },
                "guest": {"cpu_kind":"shared", "cpus":1, "memory_mb":512},
                "restart": {"policy":"on-failure", "max_retries":6},
                "processes": [{
                    "entrypoint": ["/usr/bin/tini", "--", "/usr/local/bin/kordi-human-simulator"],
                    "cmd": ["run", "--actor", self.actor_id],
                    "user": "1000:1000",
                    "env": {"KORDI_SIMULATOR_API_BASE": self.api_base},
                    "ignore_app_secrets": true,
                    "secrets": secrets
                }]
            }
        })
    }
}

fn secret_env(env_var: &str, secret: &str, key: &str) -> Value {
    json!({
        "name": env_var,
        "valueFrom": {
            "secretKeyRef": {
                "name": secret,
                "key": key
            }
        }
    })
}

fn fly_secret(env_var: &str, name: &str) -> Value {
    json!({"env_var":env_var, "name":name})
}

fn validate_actor_id(actor_id: &str) -> Result<()> {
    ensure!(
        !actor_id.is_empty()
            && actor_id.len() <= 64
            && actor_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "actor_id must contain 1 to 64 ASCII letters, digits, '-' or '_'"
    );
    Ok(())
}

fn validate_image(image: &str) -> Result<()> {
    let (name, digest) = image
        .rsplit_once("@sha256:")
        .ok_or_else(|| anyhow::anyhow!("image must be pinned with @sha256:<64 hex characters>"))?;
    ensure!(
        !name.is_empty()
            && !name.contains('@')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._/:+-".contains(&byte)),
        "image has an invalid repository reference"
    );
    ensure!(
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "image digest must contain exactly 64 hexadecimal characters"
    );
    Ok(())
}

fn validate_api_base(api_base: &str) -> Result<()> {
    ensure!(
        !api_base.is_empty() && api_base == api_base.trim(),
        "api_base must be a trimmed HTTPS origin"
    );
    let url = Url::parse(api_base).map_err(|_| anyhow::anyhow!("api_base is not a valid URL"))?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "api_base must be an HTTPS origin without credentials, path, query, or fragment"
    );
    let host = url
        .host_str()
        .expect("host was checked above")
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let loopback_ip = host
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    ensure!(
        host != "localhost" && !host.ends_with(".localhost") && !loopback_ip,
        "api_base cannot use a loopback host for a remote deployment"
    );
    Ok(())
}

fn validate_reference(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value == value.trim()
            && value.len() <= MAX_REFERENCE_CHARS
            && !value.starts_with('-')
            && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)),
        "{field} must be non-empty, printable ASCII, and not option-like"
    );
    Ok(())
}

fn validate_fly_secret_name(value: &str, field: &str) -> Result<()> {
    let bytes = value.as_bytes();
    ensure!(
        !value.is_empty()
            && value.len() <= MAX_REFERENCE_CHARS
            && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "{field} must start with an ASCII letter or underscore and contain only ASCII letters, digits, or underscores"
    );
    Ok(())
}

fn validate_optional_fly_secret_name(value: Option<&str>, field: &str) -> Result<()> {
    if let Some(value) = value {
        validate_fly_secret_name(value, field)?;
    }
    Ok(())
}

fn validate_dns_label(value: &str, field: &str) -> Result<()> {
    let bytes = value.as_bytes();
    validate_reference(value, field)?;
    ensure!(
        value.len() <= 63
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && (bytes[value.len() - 1].is_ascii_lowercase()
                || bytes[value.len() - 1].is_ascii_digit())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "{field} must be a DNS label of at most 63 lowercase letters, digits, or hyphens"
    );
    Ok(())
}

fn digest_hex(input: &[u8]) -> String {
    Sha256::digest(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "deployment_config_tests.rs"]
mod tests;
