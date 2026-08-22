use anyhow::Result;

use crate::session_bootstrap::SessionRuntimeSetup;

use super::super::DesktopChatSessionSummary;
use super::build_detail_from_setup;

pub(crate) fn build_summary_from_setup(
    setup: &SessionRuntimeSetup,
) -> Result<DesktopChatSessionSummary> {
    let detail = build_detail_from_setup(setup)?;
    Ok(DesktopChatSessionSummary {
        id: detail.id,
        title: detail.title,
        subtitle: detail.subtitle,
        updated_at_label: detail.updated_at_label,
        updated_at_ms: detail.updated_at_ms,
        message_count: detail.message_count,
        draft: detail.draft,
        background_status: None,
        forked_from_session_id: detail.forked_from_session_id.clone(),
        forked_from_message_id: detail.forked_from_message_id.clone(),
    })
}
