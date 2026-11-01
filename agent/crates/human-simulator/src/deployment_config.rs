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
mod tests {
    use super::*;
    use serde_json::json;

    const IMAGE: &str = "registry.example.invalid/simulator/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const API_BASE: &str = "https://simulator.example.invalid/";

    fn k3s_config(account_auth: AccountAuth) -> DeploymentConfig {
        DeploymentConfig {
            actor_id: "synthetic_actor_1".into(),
            image: IMAGE.into(),
            api_base: API_BASE.into(),
            backend: Backend::K3s {
                context: "synthetic-context".into(),
                namespace: "simulator-test".into(),
                worker_secret: "actor-token".into(),
                account_secret: "account-token".into(),
                account_auth,
            },
        }
    }

    fn fly_config_with_token() -> DeploymentConfig {
        DeploymentConfig {
            actor_id: "synthetic_actor_1".into(),
            image: IMAGE.into(),
            api_base: API_BASE.into(),
            backend: Backend::Fly {
                app: "simulator-test".into(),
                region: "ord".into(),
                actor_token_secret: "KORDI_SIM_ACTOR_TOKEN".into(),
                account_token_secret: Some("KORDI_SIM_ACCOUNT_TOKEN".into()),
                account_email_secret: None,
                account_password_secret: None,
            },
        }
    }

    fn fly_config_with_login() -> DeploymentConfig {
        let mut config = fly_config_with_token();
        config.backend = Backend::Fly {
            app: "simulator-test".into(),
            region: "ord".into(),
            actor_token_secret: "KORDI_SIM_ACTOR_TOKEN".into(),
            account_token_secret: None,
            account_email_secret: Some("KORDI_SIM_ACCOUNT_EMAIL".into()),
            account_password_secret: Some("KORDI_SIM_ACCOUNT_PASSWORD".into()),
        };
        config
    }

    #[test]
    fn identity_is_stable_per_actor_and_api_and_fingerprint_covers_backend_config() {
        let config = k3s_config(AccountAuth::Session);
        assert_eq!(config.identity(), config.identity());
        assert!(config.identity().starts_with("human-sim-"));
        assert!(config.identity().len() <= 63);

        let mut another_actor = config.clone();
        another_actor.actor_id.push_str("_other");
        assert_ne!(config.identity(), another_actor.identity());

        let mut another_api = config.clone();
        another_api.api_base = "https://other.example.invalid/".into();
        assert_ne!(config.identity(), another_api.identity());

        let mut another_backend = config.clone();
        another_backend.backend = Backend::K3s {
            context: "other-context".into(),
            namespace: "simulator-test".into(),
            worker_secret: "actor-token".into(),
            account_secret: "account-token".into(),
            account_auth: AccountAuth::Session,
        };
        assert_eq!(config.identity(), another_backend.identity());
        assert_ne!(config.fingerprint(), another_backend.fingerprint());
        assert_eq!(config.fingerprint().len(), 64);
    }

    #[test]
    fn k3s_manifests_use_secret_refs_and_restricted_actor_jobs() {
        let config = k3s_config(AccountAuth::Session);
        config.validate().unwrap();
        let manifest = config.manifest();
        assert_eq!(manifest["kind"], "Job");
        assert_eq!(manifest["metadata"]["name"], config.identity());
        assert_eq!(manifest["spec"]["backoffLimit"], 6);
        assert_eq!(
            manifest["spec"]["template"]["spec"]["restartPolicy"],
            "OnFailure"
        );
        assert_eq!(
            manifest["metadata"]["annotations"]["kordi.cloud/simulator-actor"],
            config.actor_id
        );
        assert_eq!(
            manifest["metadata"]["annotations"]["kordi.cloud/simulator-config"],
            config.fingerprint()
        );
        assert_eq!(
            manifest["spec"]["template"]["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"],
            true
        );
        assert_eq!(
            manifest["spec"]["template"]["spec"]["containers"][0]["env"][1]["valueFrom"]["secretKeyRef"]
                ["name"],
            "actor-token"
        );
        assert_eq!(
            manifest["spec"]["template"]["spec"]["containers"][0]["env"][2]["name"],
            "KORDI_SIM_ACCOUNT_TOKEN"
        );
        assert!(!manifest.to_string().contains("secret-value"));

        let login_manifest = k3s_config(AccountAuth::Login).manifest();
        let env = login_manifest["spec"]["template"]["spec"]["containers"][0]["env"]
            .as_array()
            .unwrap();
        assert_eq!(env[2]["name"], "KORDI_SIM_ACCOUNT_EMAIL");
        assert_eq!(env[3]["name"], "KORDI_SIM_ACCOUNT_PASSWORD");
    }

    #[test]
    fn fly_manifest_uses_only_selected_secret_references() {
        for config in [fly_config_with_token(), fly_config_with_login()] {
            config.validate().unwrap();
            let manifest = config.manifest();
            assert_eq!(manifest["name"], config.identity());
            assert_eq!(manifest["skip_service_registration"], true);
            assert_eq!(manifest["config"]["services"], json!([]));
            assert_eq!(
                manifest["config"]["processes"][0]["ignore_app_secrets"],
                true
            );
            assert_eq!(manifest["config"]["processes"][0]["user"], "1000:1000");
            assert_eq!(
                manifest["config"]["processes"][0]["secrets"][0]["env_var"],
                "KORDI_SIM_ACTOR_TOKEN"
            );
            assert_eq!(
                manifest["config"]["processes"][0]["secrets"][0]["name"],
                "KORDI_SIM_ACTOR_TOKEN"
            );
            assert!(!manifest.to_string().contains("secret-value"));
        }

        let token_manifest = fly_config_with_token().manifest();
        let token_secrets = token_manifest["config"]["processes"][0]["secrets"]
            .as_array()
            .unwrap();
        assert_eq!(token_secrets.len(), 2);
        assert_eq!(token_secrets[1]["env_var"], "KORDI_SIM_ACCOUNT_TOKEN");

        let login_manifest = fly_config_with_login().manifest();
        let login_secrets = login_manifest["config"]["processes"][0]["secrets"]
            .as_array()
            .unwrap();
        assert_eq!(login_secrets.len(), 3);
        assert_eq!(login_secrets[1]["env_var"], "KORDI_SIM_ACCOUNT_EMAIL");
        assert_eq!(login_secrets[2]["env_var"], "KORDI_SIM_ACCOUNT_PASSWORD");
    }

    #[test]
    fn rejects_unknown_fields_bad_images_urls_and_backend_references() {
        assert!(serde_json::from_value::<DeploymentConfig>(json!({
            "actor_id":"actor-1",
            "image":IMAGE,
            "api_base":API_BASE,
            "backend":{"type":"k3s","context":"ctx","namespace":"ns","worker_secret":"w","account_secret":"a","account_auth":"session"},
            "credential":"not-allowed"
        })).is_err());

        let mut config = k3s_config(AccountAuth::Session);
        config.image = "registry.invalid/worker:latest".into();
        assert!(config.validate().is_err());
        config.image = format!("worker@sha256:{}", "z".repeat(64));
        assert!(config.validate().is_err());

        for api_base in [
            "http://simulator.example.invalid/",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://user:pass@simulator.example.invalid/",
            "https://simulator.example.invalid/path",
            "https://simulator.example.invalid/?token=x",
        ] {
            let mut invalid_url = k3s_config(AccountAuth::Session);
            invalid_url.api_base = api_base.into();
            assert!(invalid_url.validate().is_err(), "accepted {api_base}");
        }

        let mut invalid_context = k3s_config(AccountAuth::Session);
        invalid_context.backend = Backend::K3s {
            context: "--context".into(),
            namespace: "simulator-test".into(),
            worker_secret: "actor-token".into(),
            account_secret: "account-token".into(),
            account_auth: AccountAuth::Session,
        };
        assert!(invalid_context.validate().is_err());

        let mut invalid_namespace = k3s_config(AccountAuth::Session);
        invalid_namespace.backend = Backend::K3s {
            context: "synthetic-context".into(),
            namespace: "-invalid".into(),
            worker_secret: "actor-token".into(),
            account_secret: "account-token".into(),
            account_auth: AccountAuth::Session,
        };
        assert!(invalid_namespace.validate().is_err());

        let mut invalid_fly_auth = fly_config_with_token();
        invalid_fly_auth.backend = Backend::Fly {
            app: "simulator-test".into(),
            region: "ord".into(),
            actor_token_secret: "KORDI_SIM_ACTOR_TOKEN".into(),
            account_token_secret: None,
            account_email_secret: Some("KORDI_SIM_ACCOUNT_EMAIL".into()),
            account_password_secret: None,
        };
        assert!(invalid_fly_auth.validate().is_err());

        let mut invalid_fly_app = fly_config_with_token();
        invalid_fly_app.backend = Backend::Fly {
            app: "simulator/test".into(),
            region: "ord".into(),
            actor_token_secret: "KORDI_SIM_ACTOR_TOKEN".into(),
            account_token_secret: Some("KORDI_SIM_ACCOUNT_TOKEN".into()),
            account_email_secret: None,
            account_password_secret: None,
        };
        assert!(invalid_fly_app.validate().is_err());

        let mut invalid_fly_region = fly_config_with_token();
        invalid_fly_region.backend = Backend::Fly {
            app: "simulator-test".into(),
            region: "--region".into(),
            actor_token_secret: "KORDI_SIM_ACTOR_TOKEN".into(),
            account_token_secret: Some("KORDI_SIM_ACCOUNT_TOKEN".into()),
            account_email_secret: None,
            account_password_secret: None,
        };
        assert!(invalid_fly_region.validate().is_err());

        for secret_name in ["KORDI-SIM-ACTOR-TOKEN", "1TOKEN", "TOKEN/NAME"] {
            let mut invalid_fly_secret = fly_config_with_token();
            invalid_fly_secret.backend = Backend::Fly {
                app: "simulator-test".into(),
                region: "ord".into(),
                actor_token_secret: secret_name.into(),
                account_token_secret: Some("KORDI_SIM_ACCOUNT_TOKEN".into()),
                account_email_secret: None,
                account_password_secret: None,
            };
            assert!(
                invalid_fly_secret.validate().is_err(),
                "accepted {secret_name}"
            );
        }
    }
}
