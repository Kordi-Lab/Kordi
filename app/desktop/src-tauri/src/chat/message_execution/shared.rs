use super::*;

pub(in crate::chat) async fn start_shared_message(
    manager: &DesktopChatManager,
    request_id: String,
    mut input: StartMessageInput,
) -> Result<DesktopChatTurnSnapshot, String> {
    let request_id = request_id.trim().to_string();
    input.shared_context = true;
    input.session_id = shared_request_runtime_session_id(&input.session_id, &request_id)?;
    if !reserve_shared_request(manager, &input.session_id, &request_id).await {
        return Err("shared_request_already_started".to_string());
    }
    input.request_message_id = Some(request_id);
    start_message(manager, input).await
}
