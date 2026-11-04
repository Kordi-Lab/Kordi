use super::*;

pub(super) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(group_space_id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> Response {
    match store::create_group_channel(
        state.db_pool(),
        &session.account_id,
        &group_space_id,
        request,
    )
    .await
    {
        Ok(outcome) => {
            if outcome.inserted {
                if let Some(agent) = state
                    .system_agent()
                    .filter(|agent| agent.config().group_chat_enabled)
                {
                    if let Err(error) = crate::system_agent::membership::join_conversation(
                        state.db_pool(),
                        &agent.config().account_id,
                        outcome.value.id,
                    )
                    .await
                    {
                        eprintln!("[system-agent] Could not join a new channel: {error}");
                    }
                }
            }
            (
                if outcome.inserted {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(ConversationResponse {
                    conversation: outcome.value,
                }),
            )
                .into_response()
        }
        Err(error) => store_error("create group channel", error),
    }
}
