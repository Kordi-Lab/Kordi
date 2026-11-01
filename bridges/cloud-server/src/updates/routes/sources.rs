use super::*;

pub(super) async fn get(
    State(state): State<Arc<ServerState>>,
    Path((version, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    respond(state, version, name, headers, false).await
}
pub(super) async fn head(
    State(state): State<Arc<ServerState>>,
    Path((version, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    respond(state, version, name, headers, true).await
}
async fn respond(
    state: Arc<ServerState>,
    version: String,
    name: String,
    headers: HeaderMap,
    head: bool,
) -> Response {
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return *response,
    };
    match store.load_source_asset(&version, &name).await {
        Ok(Some((asset, date))) => {
            asset_response(
                &store,
                &asset,
                &date,
                &headers,
                head,
                IMMUTABLE_CACHE_CONTROL,
            )
            .await
        }
        Ok(None) | Err(ReleaseStoreError::NotFound) => not_found(),
        Err(_) => unavailable(),
    }
}
