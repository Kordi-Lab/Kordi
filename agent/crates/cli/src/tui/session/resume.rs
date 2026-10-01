use anyhow::Result;
use kordi_core::agent_session::ModelRef;
use kordi_core::agent_session_runtime::RuntimeModelRef;
use kordi_core::settings::Settings;
use kordi_provider::registry::ModelRegistry;
use kordi_session::{context, store};
use kordi_tui::select_list::SelectItem;
use kordi_tui::tui::{Transcript, TuiCommand, TuiNoteLevel};

use super::super::RESUME_SESSION_MENU_ID;
use super::super::controller::TuiController;

impl TuiController {
    pub(in crate::tui) fn handle_new_session(&mut self) {
        let new_id = uuid::Uuid::new_v4().to_string();
        self.options.session_id = Some(new_id.clone());
        self.session_setup.session_id = new_id;
        self.session_setup.session_created = false;
        let _ = self.runtime_host.session_mut().clear_queue();
        self.queued_prompts.clear();
        self.pending_tree_summary_target = None;
        self.pending_tree_custom_prompt_target = None;
        self.pending_model_provider_search = None;
        self.pending_model_auth_selection = None;
        self.pending_login_auth_selection = None;
        self.pending_images.clear();
        self.retry_status = None;
        self.manual_compaction_in_progress = false;
        self.manual_compaction_generation += 1;
        if let Some(cancel) = self.local_action_cancel.take() {
            cancel.cancel();
        }
        self.send_command(TuiCommand::SetLocalActionActive(false));
        self.send_command(TuiCommand::SetTranscript(Transcript::new()));
        self.send_command(TuiCommand::SetInput(String::new()));
        self.publish_footer();
        self.send_command(TuiCommand::PushNote {
            level: TuiNoteLevel::Status,
            text: "New session started".to_string(),
        });
    }

    pub(in crate::tui) fn open_resume_menu(&mut self) -> Result<()> {
        let cwd = self.session_setup.tool_ctx.cwd.display().to_string();
        let sessions = store::list_sessions(&self.session_setup.conn, &cwd)?;
        if sessions.is_empty() {
            self.send_command(TuiCommand::SetStatusLine(
                "No sessions found in this directory.".to_string(),
            ));
            return Ok(());
        }
        let items = sessions
            .into_iter()
            .map(|row| {
                let activity_label = session_activity_label(&self.session_setup.conn, &row);
                SelectItem {
                    label: row
                        .name
                        .clone()
                        .unwrap_or_else(|| row.session_id.chars().take(8).collect()),
                    detail: Some(format!("{} entries • {}", row.entry_count, activity_label)),
                    value: row.session_id,
                }
            })
            .collect::<Vec<_>>();
        self.send_command(TuiCommand::OpenSelectMenu {
            menu_id: RESUME_SESSION_MENU_ID.to_string(),
            title: "Resume session".to_string(),
            items,
            selected_value: None,
        });
        Ok(())
    }

    pub(in crate::tui) async fn handle_resume_session(&mut self, session_id: &str) -> Result<()> {
        self.session_setup.session_id = session_id.to_string();
        self.session_setup.session_created = true;
        self.options.session_id = Some(session_id.to_string());
        let _ = self.runtime_host.session_mut().clear_queue();
        // Clear stale state from previous session's tree interactions.
        self.pending_tree_summary_target = None;
        self.pending_tree_custom_prompt_target = None;
        self.pending_model_provider_search = None;
        self.pending_model_auth_selection = None;
        self.pending_login_auth_selection = None;
        self.pending_images.clear();
        self.queued_prompts.clear();
        self.streaming = false;
        self.retry_status = None;
        self.manual_compaction_in_progress = false;
        self.manual_compaction_generation += 1;
        if let Some(cancel) = self.local_action_cancel.take() {
            cancel.cancel();
        }
        self.send_command(TuiCommand::SetLocalActionActive(false));
        self.send_command(TuiCommand::SetStatusLine("Resuming session...".to_string()));
        self.send_command(TuiCommand::SetLocalActionActive(true));
        tokio::task::yield_now().await;

        let result: Result<()> = (|| {
            let settings = Settings::load_merged(&self.session_setup.tool_ctx.cwd);
            if let Ok(session_context) =
                context::build_context(&self.session_setup.conn, session_id)
                && let Some(model_info) = session_context.model.clone()
            {
                let mut registry = ModelRegistry::new();
                registry.load_custom_models(&settings);
                crate::login::add_cached_github_copilot_models(&mut registry);
                {
                    let model = crate::runtime_model::resolve_or_synthesize_model_with_settings(
                        &registry,
                        &settings,
                        &model_info.provider,
                        &model_info.model_id,
                    );
                    let runtime = crate::runtime_model::resolve_runtime_config_with_settings(
                        &model, &settings,
                    );

                    self.runtime_host.session_mut().set_model(ModelRef {
                        provider: model.provider.clone(),
                        id: model.id.clone(),
                        reasoning: model.reasoning,
                    });
                    self.runtime_host
                        .runtime_mut()
                        .set_model(Some(RuntimeModelRef {
                            provider: model.provider.clone(),
                            id: model.id.clone(),
                            context_window: model.context_window as usize,
                        }));
                    self.session_setup.model = model;
                    self.session_setup.provider = runtime.provider.clone();
                    self.session_setup.auth = runtime.auth;
                    self.session_setup.api_key = runtime.api_key.clone();
                    self.session_setup.base_url = runtime.base_url.clone();
                    self.session_setup.headers = runtime.headers.clone();
                    self.session_setup.tool_ctx.web_search = Some(kordi_tools::WebSearchRuntime {
                        provider: self.session_setup.provider.clone(),
                        model: self.session_setup.model.clone(),
                        api_key: self.session_setup.api_key.clone(),
                        base_url: self.session_setup.base_url.clone(),
                        headers: runtime.headers,
                        enabled: true,
                    });
                    self.options.model_display = Some(format!(
                        "{}/{}",
                        self.session_setup.model.provider, self.session_setup.model.id
                    ));
                }
            }

            let requested_thinking_level = crate::session_bootstrap::resolve_thinking_level(
                None,
                context::active_path_explicit_thinking_level(&self.session_setup.conn, session_id)
                    .ok()
                    .flatten(),
                settings.default_thinking.as_deref(),
            );
            let thinking_level = crate::runtime_model::effective_thinking_level_for_model(
                &self.session_setup.model,
                self.session_setup.auth.as_ref().map(|auth| auth.method),
                requested_thinking_level,
            );
            self.session_setup.thinking_level = thinking_level.as_str().to_string();
            self.runtime_host
                .session_mut()
                .set_thinking_level(thinking_level);

            self.rebuild_current_transcript()?;
            self.send_command(TuiCommand::SetInput(String::new()));
            self.publish_footer();
            Ok(())
        })();

        self.send_command(TuiCommand::SetLocalActionActive(false));
        match result {
            Ok(()) => {
                self.send_command(TuiCommand::SetStatusLine("Resumed session".to_string()));
                Ok(())
            }
            Err(err) => {
                self.send_command(TuiCommand::SetStatusLine("Resume failed".to_string()));
                Err(err)
            }
        }
    }
}

fn session_activity_label(conn: &rusqlite::Connection, row: &store::SessionRow) -> String {
    let timestamp = store::get_last_message_timestamp(conn, &row.session_id)
        .ok()
        .flatten()
        .or_else(|| {
            store::get_last_entry_timestamp(conn, &row.session_id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| row.created_at.clone());
    format_timestamp(&timestamp)
}

fn format_timestamp(ts: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        let now = chrono::Utc::now();
        let diff = now.signed_duration_since(dt);

        if diff.num_minutes() < 1 {
            "just now".to_string()
        } else if diff.num_hours() < 1 {
            format!("{}m ago", diff.num_minutes())
        } else if diff.num_hours() < 24 {
            format!("{}h ago", diff.num_hours())
        } else if diff.num_days() < 7 {
            format!("{}d ago", diff.num_days())
        } else {
            dt.format("%Y-%m-%d").to_string()
        }
    } else {
        ts.chars().take(16).collect()
    }
}

#[cfg(test)]
mod tests;
