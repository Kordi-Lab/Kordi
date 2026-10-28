//! HTTP server entry point for the cloud-native collaboration server.
//!
//! Owns the `sqlx::PgPool`, builds the router, runs the HTTP listener.

use std::sync::Arc;

use axum::Router;
use sqlx_postgres::PgPool;
use tower_http::cors::{Any, CorsLayer};

use crate::attachments::S3Config;
use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, RateLimiterError};
use crate::calls::{CallMediaConfig, CallMediaConfigError};
use crate::events::{EventBus, EventBusError};
use crate::notifications::{PushNotificationConfigError, PushNotificationService};
use crate::pg::{init_pool, PgPoolError};
use crate::support::{PendingSupportConfig, SupportConfigError, SupportService};
use crate::system_agent::{PendingSystemAgentConfig, SystemAgentConfigError, SystemAgentService};
use crate::updates::store::{
    MinioReleaseStore, ReleaseCatalogStore, ReleaseStoreConfig, ReleaseStoreError,
};

mod logging;
mod readiness;
mod workers;

use logging::redact_url_credentials;

pub struct ServerState {
    pool: PgPool,
    events: EventBus,
    chat_sync_wakes: Arc<crate::chat_sync::realtime::ChatSyncWakeHub>,
    s3: Option<S3Config>,
    release_store: Option<ReleaseCatalogStore>,
    support: Option<SupportService>,
    system_agent: Option<SystemAgentService>,
    call_media: Option<CallMediaConfig>,
    notifications: Option<PushNotificationService>,
    signup_email: Option<crate::auth::signup_email::SignupEmailService>,
    legacy_signup_until: Option<chrono::DateTime<chrono::Utc>>,
    connectors: crate::connectors::ConnectorRuntime,
    document_rooms: Arc<crate::document_shares::collab::RoomRegistry>,
}

impl ServerState {
    pub fn new(pool: PgPool, events: EventBus) -> Self {
        Self {
            pool,
            events,
            chat_sync_wakes: crate::chat_sync::realtime::ChatSyncWakeHub::new(),
            s3: None,
            release_store: None,
            support: None,
            system_agent: None,
            call_media: None,
            notifications: None,
            signup_email: None,
            legacy_signup_until: None,
            connectors: crate::connectors::ConnectorRuntime::from_env(),
            document_rooms: crate::document_shares::collab::RoomRegistry::new(),
        }
    }

    pub fn with_s3(mut self, s3: S3Config) -> Self {
        self.s3 = Some(s3);
        self
    }

    pub fn with_signup_email(
        mut self,
        service: crate::auth::signup_email::SignupEmailService,
    ) -> Self {
        self.signup_email = Some(service);
        self
    }

    pub fn signup_email(&self) -> Option<&crate::auth::signup_email::SignupEmailService> {
        self.signup_email.as_ref()
    }

    /// Opens code-less password signup for older clients until `deadline`.
    pub fn with_legacy_signup_until(mut self, deadline: chrono::DateTime<chrono::Utc>) -> Self {
        self.legacy_signup_until = Some(deadline);
        self
    }

    pub fn legacy_signup_is_open(&self) -> bool {
        crate::auth::legacy_signup::legacy_signup_is_open(
            self.legacy_signup_until,
            chrono::Utc::now(),
        )
    }

    pub fn with_release_store(mut self, release_store: ReleaseCatalogStore) -> Self {
        self.release_store = Some(release_store);
        self
    }

    pub fn with_system_agent(mut self, system_agent: SystemAgentService) -> Self {
        self.system_agent = Some(system_agent);
        self
    }

    pub fn with_support(mut self, support: SupportService) -> Self {
        self.support = Some(support);
        self
    }

    pub fn with_call_media(mut self, call_media: CallMediaConfig) -> Self {
        self.call_media = Some(call_media);
        self
    }

    pub fn with_notifications(mut self, notifications: PushNotificationService) -> Self {
        self.notifications = Some(notifications);
        self
    }

    /// Replaces the connector cipher and providers; tests inject the stub.
    pub fn with_connector_runtime(mut self, runtime: crate::connectors::ConnectorRuntime) -> Self {
        self.connectors = runtime;
        self
    }

    /// Charges connector tool calls to `limiter`, the limiter the router
    /// shares, so the per-account budget holds across replicas.
    pub fn with_connector_call_limiter(mut self, limiter: Arc<CloudRateLimiter>) -> Self {
        let budget = self.connectors.budget.clone().with_limiter(limiter);
        self.connectors.budget = budget;
        self
    }

    pub fn connectors(&self) -> &crate::connectors::ConnectorRuntime {
        &self.connectors
    }

    pub(crate) fn document_rooms(&self) -> &crate::document_shares::collab::RoomRegistry {
        &self.document_rooms
    }

    pub fn db_pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    pub(crate) fn chat_sync_wakes(&self) -> &Arc<crate::chat_sync::realtime::ChatSyncWakeHub> {
        &self.chat_sync_wakes
    }

    pub fn s3(&self) -> Option<&S3Config> {
        self.s3.as_ref()
    }

    pub fn release_store(&self) -> Option<&ReleaseCatalogStore> {
        self.release_store.as_ref()
    }

    pub fn system_agent(&self) -> Option<&SystemAgentService> {
        self.system_agent.as_ref()
    }

    pub fn support(&self) -> Option<&SupportService> {
        self.support.as_ref()
    }

    pub fn call_media(&self) -> Option<&CallMediaConfig> {
        self.call_media.as_ref()
    }

    pub fn notifications(&self) -> Option<&PushNotificationService> {
        self.notifications.as_ref()
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
    router_with_shared_rate_limiter(state, Arc::new(rate_limiter))
}

pub fn router_with_shared_rate_limiter(
    state: Arc<ServerState>,
    rate_limiter: Arc<CloudRateLimiter>,
) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let readiness_state = state.clone();
    let readiness_limiter = rate_limiter.clone();
    let ws_router = Router::new()
        .route("/v1/cloud/ws", axum::routing::get(crate::ws::ws_handler))
        .route(
            "/v2/chat/realtime",
            axum::routing::get(crate::chat_sync::realtime::ws_handler),
        )
        .with_state(state.clone());
    let playback_router = Router::new()
        .route(
            "/v1/cloud/public/attachments/:attachment_id/content",
            axum::routing::get(crate::attachments::playback::content),
        )
        .with_state(state.clone());

    Router::new()
        .merge(playback_router)
        .merge(crate::avatars::routes(state.clone()))
        .merge(crate::blob_emoji::routes())
        .merge(crate::auth::routes::routes_with_shared_rate_limiter(
            state.clone(),
            crate::auth::password::PasswordHasherConfig::production(),
            rate_limiter.clone(),
        ))
        .merge(
            crate::chat_sync::routes::routes(state.clone())
                .layer(axum::Extension(rate_limiter.clone())),
        )
        .merge(crate::calls::routes(state.clone()))
        .merge(crate::cloud_agents::routes::routes(state.clone()))
        .merge(crate::connectors::routes::routes(state.clone()))
        .merge(crate::document_shares::routes(
            state.clone(),
            rate_limiter.clone(),
        ))
        .merge(crate::common_ground::routes(
            state.clone(),
            rate_limiter.clone(),
        ))
        .merge(
            crate::cloud_agent_runtime::routes::routes(state.clone())
                .layer(axum::Extension(rate_limiter.clone())),
        )
        .merge(
            crate::scheduled_tasks::routes::routes(state.clone())
                .layer(axum::Extension(rate_limiter)),
        )
        .merge(crate::digest::routes(state.clone()))
        .merge(crate::plan_cards::routes(state.clone()))
        .merge(crate::projects::routes(state.clone()))
        .merge(crate::support::routes(state.clone()))
        .merge(crate::updates::routes::routes(state.clone()))
        .merge(ws_router)
        .route("/health", axum::routing::get(health))
        .route(
            "/ready",
            axum::routing::get(move || {
                readiness::ready(readiness_state.clone(), readiness_limiter.clone())
            }),
        )
        .layer(cors)
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "ok": true, "server": "kordi-cloud" }))
}

#[derive(Debug)]
pub enum RunError {
    Configuration(&'static str),
    Pool(PgPoolError),
    Events(EventBusError),
    RateLimiter(RateLimiterError),
    Support(SupportConfigError),
    SystemAgent(SystemAgentConfigError),
    CallMedia(CallMediaConfigError),
    Notifications(PushNotificationConfigError),
    Bind(std::io::Error),
    Serve(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configuration(err) => write!(f, "{err}"),
            Self::Pool(err) => write!(f, "{err}"),
            Self::Events(err) => write!(f, "{err}"),
            Self::RateLimiter(err) => write!(f, "{err}"),
            Self::Support(err) => write!(f, "configure support: {err}"),
            Self::SystemAgent(err) => write!(f, "configure the System agent: {err}"),
            Self::CallMedia(err) => write!(f, "configure call media: {err}"),
            Self::Notifications(err) => write!(f, "configure Apple notifications: {err}"),
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
pub async fn run(
    port: u16,
    database_url: &str,
    nats_url: Option<&str>,
    redis_url: Option<&str>,
) -> Result<(), RunError> {
    if std::env::var("KORDI_REQUIRE_CORE_SERVICES").as_deref() == Ok("true")
        && (nats_url.is_none()
            || redis_url.is_none()
            || S3Config::from_env().is_none()
            || crate::auth::signup_email::SignupEmailService::from_env().is_none())
    {
        return Err(RunError::Configuration(
            "Hosted deployment requires NATS, Redis, S3, and signup email configuration",
        ));
    }
    let pool = init_pool(database_url).await.map_err(RunError::Pool)?;
    let events = match nats_url {
        Some(url) => {
            println!("Kordi cloud server connecting to NATS");
            EventBus::connect(url).await.map_err(RunError::Events)?
        }
        None => {
            println!("Kordi cloud server starting without NATS (events disabled)");
            EventBus::noop()
        }
    };
    let rate_limiter = Arc::new(match redis_url {
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
    });
    let mut state =
        ServerState::new(pool, events).with_connector_call_limiter(rate_limiter.clone());
    if let Some(service) = crate::auth::signup_email::SignupEmailService::from_env() {
        state = state.with_signup_email(service);
        println!("Kordi signup email verification is configured");
    } else {
        println!("Kordi password signup is unavailable until signup email delivery is configured");
    }
    if let Some(deadline) = crate::auth::legacy_signup::legacy_signup_until_from_env() {
        state = state.with_legacy_signup_until(deadline);
        println!(
            "Kordi legacy password signup without an email code is open until {}",
            deadline.to_rfc3339()
        );
    }
    if let Some(call_media) = CallMediaConfig::from_env().map_err(RunError::CallMedia)? {
        println!("Kordi call media is configured");
        state = state.with_call_media(call_media);
    } else {
        println!("Kordi call media is disabled");
    }
    if let Some(notifications) =
        PushNotificationService::from_env().map_err(RunError::Notifications)?
    {
        println!("Kordi Apple notifications are configured");
        state = state.with_notifications(notifications);
    } else {
        println!("Kordi Apple notifications are disabled");
    }
    if let Some(pending) = PendingSupportConfig::from_env().map_err(RunError::Support)? {
        let support_config = crate::support::bootstrap_support_agent(state.db_pool(), pending)
            .await
            .map_err(RunError::Support)?;
        println!(
            "Kordi support contact configured for {}",
            support_config.owner_email
        );
        state = state.with_support(SupportService::new(support_config));
    } else {
        println!("Kordi support contact is disabled");
    }
    crate::system_account::bootstrap(state.db_pool()).await;
    if let Some(pending) = PendingSystemAgentConfig::from_env().map_err(RunError::SystemAgent)? {
        let system_agent_config =
            crate::system_agent::bootstrap_system_agent(state.db_pool(), pending)
                .await
                .map_err(RunError::SystemAgent)?;
        println!(
            "Kordi System agent configured as {} ({})",
            system_agent_config.name, system_agent_config.account_id
        );
        state = state.with_system_agent(SystemAgentService::new(system_agent_config));
    } else {
        println!("Kordi System agent is disabled");
    }
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
    if let Some(config) = ReleaseStoreConfig::from_env() {
        match MinioReleaseStore::new(config) {
            Ok(backend) => {
                println!("Kordi cloud server release store configured (bucket=kordi-releases)");
                state = state.with_release_store(ReleaseCatalogStore::new(Arc::new(backend)));
            }
            Err(ReleaseStoreError::Unavailable) => {
                println!("Kordi cloud server release store is unavailable");
            }
            Err(_) => {
                println!("Kordi cloud server release store configuration was rejected");
            }
        }
    } else {
        println!(
            "Kordi cloud server starting without desktop release storage (set KORDI_RELEASE_S3_ENDPOINT, KORDI_RELEASE_S3_BUCKET, KORDI_RELEASE_S3_ACCESS_KEY, KORDI_RELEASE_S3_SECRET_KEY)"
        );
    }
    let state = Arc::new(state);
    workers::spawn_background_workers(&state, database_url, &rate_limiter);
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
    let app = router_with_shared_rate_limiter(state, rate_limiter);
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
