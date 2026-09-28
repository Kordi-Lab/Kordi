//! Provider login against the real OMP route worker from
//! `experiments/omp-provider-routing`, without external network access: Groq's
//! key login has no OMP validation rule, so the worker never contacts Groq.
//! CI does not install Bun, so the test is ignored by default and runs with
//! `cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e real_worker
//! -- --ignored`, which fails loudly when a prerequisite is missing.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::login_session::{
    assert_no_material, cloud_login_snapshots, login_request, login_router,
};
use super::omp_worker::{lock_worker_env, WORKER_TOKEN_ENV, WORKER_URL_ENV};
use super::*;

const GROQ_KEY: &str = "synthetic-groq-key";
/// Providers in the pinned OMP 18.2.11 catalog, plus the login-only Codex
/// device sign-in.
const OMP_CATALOG_PROVIDERS: usize = 74;

/// Kills the worker when the test ends, including when an assertion fails.
struct WorkerProcess(Child);

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// Starts the worker's own fetch handler, login sessions, and key validation.
/// `live-server.ts` binds every interface when run directly, so the test
/// serves the same handler on loopback only.
fn spawn_worker(bun: &Path, dir: &Path, port: u16, token: &str) -> WorkerProcess {
    let module = |name: &str| serde_json::to_string(&dir.join(name)).unwrap();
    let script = format!(
        "import {{ createWorkerFetch, validateHostedApiKey }} from {live};\n\
         import {{ LoginSessionManager, ompLoginRegistry }} from {sessions};\n\
         const loginSessions = new LoginSessionManager({{\n\
           registry: ompLoginRegistry((provider, apiKey, signal) =>\n\
             validateHostedApiKey(provider, apiKey, signal)),\n\
         }});\n\
         Bun.serve({{\n\
           hostname: '127.0.0.1',\n\
           port: Number(Bun.env.KORDI_OMP_ROUTE_WORKER_PORT),\n\
           idleTimeout: 60,\n\
           fetch: createWorkerFetch(Bun.env.KORDI_OMP_ROUTE_WORKER_TOKEN, loginSessions),\n\
         }});\n",
        live = module("live-server.ts"),
        sessions = module("login-sessions.ts"),
    );
    let child = Command::new(bun)
        .arg("-e")
        .arg(script)
        .current_dir(dir)
        .env("KORDI_OMP_ROUTE_WORKER_TOKEN", token)
        .env("KORDI_OMP_ROUTE_WORKER_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .expect("start the OMP route worker");
    WorkerProcess(child)
}

async fn wait_until_healthy(worker: &mut WorkerProcess, url: &str) {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let health = client
            .get(format!("{url}/health"))
            .timeout(Duration::from_secs(1))
            .send()
            .await;
        if let Ok(response) = health {
            if response.text().await.ok().as_deref() == Some("ok") {
                return;
            }
        }
        if let Some(status) = worker.0.try_wait().unwrap() {
            panic!("the OMP route worker exited before it was healthy: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "the OMP route worker was not healthy within 30 seconds"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
#[ignore = "needs Bun, the worker's node_modules, and DATABASE_URL; run with --ignored"]
async fn provider_login_saves_a_groq_key_through_the_real_omp_worker() {
    let pool = try_pool()
        .await
        .expect("set DATABASE_URL to a disposable test database to run the real OMP worker test");
    let dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../experiments/omp-provider-routing");
    let bun = find_on_path("bun").expect("install `bun` to run the real OMP route worker");
    assert!(
        dir.join("node_modules/@oh-my-pi").is_dir(),
        "run `bun install` in experiments/omp-provider-routing first"
    );
    let _worker_env = lock_worker_env().await;
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let token = format!("synthetic-worker-token-{}", uuid::Uuid::new_v4().simple());
    let url = format!("http://127.0.0.1:{port}");
    let mut worker = spawn_worker(&bun, &dir, port, &token);
    wait_until_healthy(&mut worker, &url).await;
    std::env::set_var(WORKER_URL_ENV, &url);
    std::env::set_var(WORKER_TOKEN_ENV, &token);

    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-real-worker", "Owner").await;

    let catalog = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/cloud/agent-provider-auth/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(catalog.status(), StatusCode::OK);
    let catalog = read_json(catalog).await;
    let providers = catalog["providers"].as_array().unwrap();
    assert_eq!(providers.len(), OMP_CATALOG_PROVIDERS);
    assert!(providers.iter().all(|row| row["login"].is_object()));
    let groq_login = &providers.iter().find(|row| row["id"] == "groq").unwrap()["login"];

    let (status, started) = login_request(
        &router,
        &owner.token,
        "POST",
        "/start",
        Some(json!({ "provider": "groq", "label": "Groq test" })),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(started["status"], "awaiting-input");
    // The key step carries OMP's own Groq policy text (null in OMP 18.2.11).
    assert_eq!(
        started["step"],
        json!({
            "type": "api-key",
            "instructions": groq_login["instructions"],
            "prompt": groq_login["prompt"],
            "placeholder": groq_login["placeholder"],
            "authUrl": groq_login["authUrl"],
        })
    );
    let session_id = started["sessionId"].as_str().unwrap().to_string();

    let (status, checking) = login_request(
        &router,
        &owner.token,
        "POST",
        &format!("/{session_id}/input"),
        Some(json!({ "value": GROQ_KEY })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{checking}");
    let mut completed = Value::Null;
    for _ in 0..10 {
        let (status, polled) = login_request(
            &router,
            &owner.token,
            "GET",
            &format!("/{session_id}?wait=5"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{polled}");
        if polled["status"] == "completed" {
            completed = polled;
            break;
        }
    }
    let auth_choice = format!("cloud-login:{session_id}");
    assert_eq!(completed["snapshot"]["provider"], "groq", "{completed}");
    assert_eq!(completed["snapshot"]["authChoice"], auth_choice.as_str());
    assert_eq!(completed["snapshot"]["label"], "Groq test");
    assert_no_material(&completed);
    let (status, again) = login_request(
        &router,
        &owner.token,
        "GET",
        &format!("/{session_id}"),
        None,
    )
    .await;
    assert_eq!((status, &again), (StatusCode::OK, &completed));

    let listed = router
        .clone()
        .oneshot(get_with_token(
            "/v1/cloud/agent-provider-auth/snapshots",
            &owner.token,
        ))
        .await
        .unwrap();
    let listed = read_json(listed).await;
    assert!(!listed.to_string().contains(GROQ_KEY));
    let cloud_logins: Vec<&Value> = listed["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|snapshot| snapshot["authChoice"] == auth_choice.as_str())
        .collect();
    assert_eq!(cloud_logins.len(), 1, "{listed}");
    assert_eq!(cloud_logins[0]["label"], "Groq test");
    assert_eq!(
        cloud_login_snapshots(&pool, &owner.account_id).await,
        vec![(
            "groq".to_string(),
            auth_choice,
            Some("Groq test".to_string()),
            true
        )]
    );

    let (status, rejected) = login_request(
        &router,
        &owner.token,
        "POST",
        "/start",
        Some(json!({ "provider": "kordi-unknown-provider", "label": "Unknown" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert_eq!(rejected["errorCode"], "login_unsupported");
    assert_eq!(rejected["reason"], "unknown_provider");
}
