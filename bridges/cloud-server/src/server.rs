//! HTTP server entry point for the cloud-native collaboration server.
//!
//! Owns the `sqlx::PgPool`, builds the router, runs the HTTP listener.

use std::sync::Arc;

use axum::{Json, Router};
use serde::Serialize;
use sqlx_postgres::PgPool;
use tower_http::cors::{Any, CorsLayer};

use crate::attachments::S3Config;
use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, RateLimiterError};
use crate::events::{EventBus, EventBusError};
use crate::pg::{PgPoolError, init_pool};

pub struct ServerState {
    pool: PgPool,
    events: EventBus,
    s3: Option<S3Config>,
}

impl ServerState {
    pub fn new(pool: PgPool, events: EventBus) -> Self {
        Self {
            pool,
            events,
            s3: None,
        }
    }

    pub fn with_s3(mut self, s3: S3Config) -> Self {
        self.s3 = Some(s3);
        self
    }

    pub fn db_pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    pub fn s3(&self) -> Option<&S3Config> {
        self.s3.as_ref()
    }
}

/// Build the public router with the default production rate limiter
/// (in-memory). Tests and `run` use [`router_with_rate_limiter`] when
/// they need to inject a Redis-backed limiter.
pub fn router(state: Arc<ServerState>) -> Router {
    router_with_rate_limiter(
        state,
        CloudRateLimiter::memory(CloudRateLimitConfig::production()),
    )
}

pub fn router_with_rate_limiter(state: Arc<ServerState>, rate_limiter: CloudRateLimiter) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let ws_router = Router::new()
        .route("/v1/cloud/ws", axum::routing::get(crate::ws::ws_handler))
        .with_state(state.clone());

    Router::new()
        .merge(crate::auth::routes::routes_with_config(
            state.clone(),
            crate::auth::password::PasswordHasherConfig::production(),
            rate_limiter,
        ))
        .merge(crate::cloud_agents::routes::routes(state.clone()))
        .merge(crate::cloud_agent_runtime::routes::routes(state.clone()))
        .merge(crate::scheduled_tasks::routes::routes(state.clone()))
        .merge(updates_routes())
        .merge(ws_router)
        .route("/health", axum::routing::get(health))
        .layer(cors)
}

pub fn updates_routes() -> Router {
    Router::new().route(
        "/updates/releases/version",
        axum::routing::get(update_release_version),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReleaseVersionResponse {
    version: String,
    changelog_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_command: Option<String>,
}

async fn update_release_version() -> Json<UpdateReleaseVersionResponse> {
    Json(UpdateReleaseVersionResponse {
        version: std::env::var("KORDI_RELEASE_VERSION")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        changelog_url: std::env::var("KORDI_RELEASE_CHANGELOG_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://github.com/Kordi-AI/Kordi/releases".to_string()),
        install_command: std::env::var("KORDI_RELEASE_INSTALL_COMMAND")
            .ok()
            .filter(|value| !value.trim().is_empty()),
    })
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "ok": true, "server": "kordi-cloud" }))
}

#[derive(Debug)]
pub enum RunError {
    Pool(PgPoolError),
    Events(EventBusError),
    RateLimiter(RateLimiterError),
    Bind(std::io::Error),
    Serve(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pool(err) => write!(f, "{err}"),
            Self::Events(err) => write!(f, "{err}"),
            Self::RateLimiter(err) => write!(f, "{err}"),
            Self::Bind(err) => write!(f, "bind: {err}"),
            Self::Serve(err) => write!(f, "serve: {err}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Boot the cloud-server HTTP API. Initialises the database, optionally
/// connects to NATS for event publishing and Redis for the rate
/// limiter, builds the router, listens on `port`. `database_url` is
/// required; `nats_url` and `redis_url` are optional — when unset the
/// server falls back to no-op events and an in-memory limiter so
/// dev/CI work without those dependencies.
fn redact_url_credentials(value: &str) -> String {
    let Some(scheme_end) = value.find("://") else {
        return value.to_string();
    };
    let scheme_prefix_end = scheme_end + 3;
    let after_scheme = &value[scheme_prefix_end..];
    let Some(at_index) = after_scheme.find('@') else {
        return value.to_string();
    };
    let credentials = &after_scheme[..at_index];
    let Some(password_separator) = credentials.find(':') else {
        return value.to_string();
    };

    format!(
        "{}{}:***@{}",
        &value[..scheme_prefix_end],
        &credentials[..password_separator],
        &after_scheme[at_index + 1..]
    )
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::sync::{Mutex, OnceLock};

    use tower::ServiceExt;

    use super::{redact_url_credentials, updates_routes};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[tokio::test]
    async fn update_release_version_route_returns_public_version_metadata() {
        let _guard = env_lock().lock().unwrap();
        unsafe { std::env::set_var("KORDI_RELEASE_VERSION", "0.0.1-beta.6") };
        unsafe {
            std::env::set_var(
                "KORDI_RELEASE_CHANGELOG_URL",
                "https://coordinar.io/releases",
            )
        };
        unsafe {
            std::env::set_var(
                "KORDI_RELEASE_INSTALL_COMMAND",
                "Download Kordi from coordinar.io",
            )
        };

        let response = updates_routes()
            .oneshot(
                Request::builder()
                    .uri("/updates/releases/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["version"], "0.0.1-beta.6");
        assert_eq!(json["changelogUrl"], "https://coordinar.io/releases");
        assert_eq!(json["installCommand"], "Download Kordi from coordinar.io");

        unsafe { std::env::remove_var("KORDI_RELEASE_VERSION") };
        unsafe { std::env::remove_var("KORDI_RELEASE_CHANGELOG_URL") };
        unsafe { std::env::remove_var("KORDI_RELEASE_INSTALL_COMMAND") };
    }

    #[test]
    fn redacts_credentials_from_logged_urls() {
        assert_eq!(
            redact_url_credentials(
                "redis://default:secret-password@redis.kordi-cloud.svc.cluster.local:6379/0"
            ),
            "redis://default:***@redis.kordi-cloud.svc.cluster.local:6379/0"
        );
        assert_eq!(
            redact_url_credentials(
                "redis://default:secret/with+reserved=chars@redis.kordi-cloud.svc.cluster.local:6379/0"
            ),
            "redis://default:***@redis.kordi-cloud.svc.cluster.local:6379/0"
        );
        assert_eq!(
            redact_url_credentials("nats://nats.kordi-cloud.svc.cluster.local:4222"),
            "nats://nats.kordi-cloud.svc.cluster.local:4222"
        );
    }
}

pub async fn run(
    port: u16,
    database_url: &str,
    nats_url: Option<&str>,
    redis_url: Option<&str>,
) -> Result<(), RunError> {
    let pool = init_pool(database_url).await.map_err(RunError::Pool)?;
    let events = match nats_url {
        Some(url) => {
            println!("Kordi cloud server connecting to NATS at {url}");
            EventBus::connect(url).await.map_err(RunError::Events)?
        }
        None => {
            println!("Kordi cloud server starting without NATS (events disabled)");
            EventBus::noop()
        }
    };
    let rate_limiter = match redis_url {
        Some(url) => {
            println!(
                "Kordi cloud server connecting to Redis at {}",
                redact_url_credentials(url)
            );
            CloudRateLimiter::redis(url, CloudRateLimitConfig::production())
                .await
                .map_err(RunError::RateLimiter)?
        }
        None => {
            println!("Kordi cloud server starting without Redis (rate limiter is in-memory)");
            CloudRateLimiter::memory(CloudRateLimitConfig::production())
        }
    };
    let mut state = ServerState::new(pool, events);
    if let Some(s3) = S3Config::from_env() {
        println!(
            "Kordi cloud server attachment store at {} (bucket={})",
            s3.endpoint, s3.bucket
        );
        state = state.with_s3(s3);
    } else {
        println!(
            "Kordi cloud server starting without S3 (attachments disabled — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)"
        );
    }
    let state = Arc::new(state);
    crate::scheduled_tasks::worker::spawn_scheduled_task_worker(state.clone());
    let sweeper_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(crate::presence::presence_sweep_interval());
        loop {
            interval.tick().await;
            if let Err(err) = crate::presence::sweep_stale_presence(
                sweeper_state.db_pool(),
                sweeper_state.events(),
            )
            .await
            {
                eprintln!("[presence] sweep stale devices: {err}");
            }
        }
    });
    let app = router_with_rate_limiter(state, rate_limiter);
    let addr = format!("0.0.0.0:{port}");
    println!("Kordi cloud server on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(RunError::Bind)?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .map_err(RunError::Serve)?;
    Ok(())
}
