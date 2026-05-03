use kordi_cli::desktop_runtime::DesktopRuntimeSession;

use super::DesktopChatMessageRoute;

pub(super) fn normalized_message_route_value(value: Option<&String>) -> Option<&str> {
    value
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
}

pub(super) fn apply_desktop_chat_message_route(
    session: &mut DesktopRuntimeSession,
    route: Option<&DesktopChatMessageRoute>,
) -> Result<(), String> {
    let Some(route) = route else {
        return Ok(());
    };

    if let Some(model) = normalized_message_route_value(route.model.as_ref()) {
        session
            .set_model(model)
            .map_err(|error| error.to_string())?;
    }
    if let (Some(auth_provider), Some(auth_choice)) = (
        normalized_message_route_value(route.auth_provider.as_ref()),
        normalized_message_route_value(route.auth_choice.as_ref()),
    ) {
        session
            .set_auth_choice(auth_provider, auth_choice)
            .map_err(|error| error.to_string())?;
    }
    if let Some(thinking) = normalized_message_route_value(route.thinking.as_ref()) {
        session
            .set_thinking(thinking)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_route_value_treats_default_as_unset() {
        assert_eq!(
            normalized_message_route_value(Some(&"default".to_string())),
            None,
        );
    }
}
