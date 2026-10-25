//! How the `kordi` command line becomes session bootstrap options.

use super::SessionBootstrapOptions;
use crate::tool_registry::ToolSelectionPreference;

impl From<&crate::Cli> for SessionBootstrapOptions {
    fn from(cli: &crate::Cli) -> Self {
        let prompt_label = prompt_label_for_cli(cli);
        Self {
            messages: cli.messages.clone(),
            provider: cli.provider.clone(),
            model: cli.model.clone(),
            thinking: cli.thinking.clone(),
            system_prompt: cli.system_prompt.clone(),
            append_system_prompt: cli.append_system_prompt.clone(),
            extensions: cli.extensions.clone(),
            tool_selection: if cli.no_tools {
                ToolSelectionPreference::None
            } else if let Some(tools) = &cli.tools {
                ToolSelectionPreference::Only(
                    tools
                        .split(',')
                        .map(|name| name.trim())
                        .filter(|name| !name.is_empty())
                        .map(|name| name.to_string())
                        .collect(),
                )
            } else {
                ToolSelectionPreference::UseSettings
            },
            skill_names: None,
            skill_paths: Vec::new(),
            isolate_extensions: false,
            proactive_run: false,
            session: cli.session.clone(),
            continue_session: cli.r#continue,
            resume: cli.resume,
            prompt_label,
        }
    }
}

pub(super) fn prompt_label_for_cli(cli: &crate::Cli) -> String {
    if cli.system_prompt_template.is_some() {
        cli.system_prompt_template.clone().unwrap_or_default()
    } else if cli.system_prompt.is_some() {
        "custom".to_string()
    } else if cli.append_system_prompt.is_some() {
        "default+append".to_string()
    } else {
        "default".to_string()
    }
}
