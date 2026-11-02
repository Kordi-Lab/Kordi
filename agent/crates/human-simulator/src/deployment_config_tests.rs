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
