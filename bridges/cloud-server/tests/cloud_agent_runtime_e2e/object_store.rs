use std::collections::HashMap;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::OriginalUri;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use kordi_cloud_server::attachments::S3Config;
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::server::ServerState;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

use super::test_router;

#[derive(Clone)]
pub(super) struct TestObjectStore {
    endpoint: String,
}

#[derive(Default)]
struct TestObjectStoreState {
    objects: HashMap<String, Vec<u8>>,
    parts: HashMap<(String, String, u32), Vec<u8>>,
}

impl TestObjectStore {
    pub(super) async fn spawn() -> Self {
        Self::spawn_with_put_status(StatusCode::OK).await
    }

    pub(super) async fn spawn_rejecting_puts() -> Self {
        Self::spawn_with_put_status(StatusCode::BAD_GATEWAY).await
    }

    async fn spawn_with_put_status(put_status: StatusCode) -> Self {
        let state = Arc::new(Mutex::new(TestObjectStoreState::default()));
        let app_state = state.clone();
        let app =
            axum::Router::new().fallback(move |method: Method, uri: OriginalUri, body: Body| {
                let state = app_state.clone();
                async move {
                    let key = uri.0.path().trim_start_matches('/').to_string();
                    let query = url::form_urlencoded::parse(
                        uri.0.query().unwrap_or_default().as_bytes(),
                    )
                    .into_owned()
                    .collect::<HashMap<_, _>>();
                    match method {
                        Method::PUT => {
                            if !put_status.is_success() {
                                return put_status.into_response();
                            }
                            let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
                            if let (Some(upload_id), Some(part_number)) =
                                (query.get("uploadId"), query.get("partNumber"))
                            {
                                let part_number = part_number.parse::<u32>().unwrap();
                                state.lock().await.parts.insert(
                                    (key, upload_id.clone(), part_number),
                                    bytes.to_vec(),
                                );
                                axum::response::Response::builder()
                                    .status(StatusCode::OK)
                                    .header("etag", format!("\"part-{part_number}\""))
                                    .body(Body::empty())
                                    .unwrap()
                            } else {
                                state.lock().await.objects.insert(key, bytes.to_vec());
                                StatusCode::OK.into_response()
                            }
                        }
                        Method::POST if query.contains_key("uploads") => {
                            let upload_id = format!("upload-{}", uuid::Uuid::new_v4().simple());
                            format!(
                                "<InitiateMultipartUploadResult><UploadId>{upload_id}</UploadId></InitiateMultipartUploadResult>"
                            )
                            .into_response()
                        }
                        Method::POST => {
                            let Some(upload_id) = query.get("uploadId") else {
                                return StatusCode::BAD_REQUEST.into_response();
                            };
                            let mut state = state.lock().await;
                            let mut parts = state
                                .parts
                                .iter()
                                .filter(|((part_key, part_upload_id, _), _)| {
                                    part_key == &key && part_upload_id == upload_id
                                })
                                .map(|((_, _, part_number), bytes)| (*part_number, bytes.clone()))
                                .collect::<Vec<_>>();
                            parts.sort_by_key(|part| part.0);
                            state.objects.insert(
                                key.clone(),
                                parts.into_iter().flat_map(|part| part.1).collect(),
                            );
                            state.parts.retain(|(part_key, part_upload_id, _), _| {
                                part_key != &key || part_upload_id != upload_id
                            });
                            StatusCode::OK.into_response()
                        }
                        Method::DELETE => {
                            if let Some(upload_id) = query.get("uploadId") {
                                state.lock().await.parts.retain(
                                    |(part_key, part_upload_id, _), _| {
                                        part_key != &key || part_upload_id != upload_id
                                    },
                                );
                            }
                            StatusCode::NO_CONTENT.into_response()
                        }
                        Method::GET => match state.lock().await.objects.get(&key).cloned() {
                            Some(bytes) => bytes.into_response(),
                            None => StatusCode::NOT_FOUND.into_response(),
                        },
                        Method::HEAD => match state.lock().await.objects.get(&key).map(Vec::len) {
                            Some(size) => axum::response::Response::builder()
                                .status(StatusCode::OK)
                                .header("content-length", size)
                                .body(Body::empty())
                                .unwrap(),
                            None => StatusCode::NOT_FOUND.into_response(),
                        },
                        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
                    }
                }
            });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint: format!("http://{addr}"),
        }
    }

    fn s3_config(&self) -> S3Config {
        S3Config {
            endpoint: Url::parse(&self.endpoint).unwrap(),
            region: "us-east-1".to_string(),
            bucket: "kordi-test".to_string(),
            access_key: "test-access".to_string(),
            secret_key: "test-secret".to_string(),
        }
    }
}

pub(super) fn test_router_with_s3(
    pool: sqlx_postgres::PgPool,
    store: &TestObjectStore,
) -> axum::Router {
    let state = Arc::new(ServerState::new(pool, EventBus::noop()).with_s3(store.s3_config()));
    test_router(state)
}
