use crate::extensions::ExtensionCommandRegistry;
use kordi_hooks::Event;
use kordi_monitor::RequestMutationFlags;
use tokio::sync::mpsc;
use tracing::warn;

use super::TurnEvent;
use super::panic::catch_contained_panics;

pub(super) fn request_mutation_flags(context_rewritten: bool) -> RequestMutationFlags {
    RequestMutationFlags {
        context_rewritten,
        ..Default::default()
    }
}

pub(super) async fn send_extension_event_safe(
    extensions: &ExtensionCommandRegistry,
    event: Event,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    context: &str,
) -> Option<kordi_hooks::HookResult> {
    match catch_contained_panics(extensions.send_event(&event)).await {
        Ok(result) => result,
        Err(message) => {
            let text = format!("extension hook panicked during {context}: {message}");
            warn!("{text}");
            let _ = event_tx.send(TurnEvent::Error(text));
            None
        }
    }
}
