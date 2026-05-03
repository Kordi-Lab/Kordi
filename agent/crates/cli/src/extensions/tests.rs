use std::fs;

use kordi_core::agent_session_extensions::{
    PromptTemplateDefinition, PromptTemplateInfo, SkillDefinition, SkillInfo,
};
use kordi_core::settings::PackageEntry;
use tempfile::tempdir;

use super::command_results::{
    parse_command_activate_agent_result, parse_command_dispatch_result, parse_command_invocation,
    parse_command_menu_result, parse_command_prompt_result, render_command_result,
};
use super::plugin_runtime::{build_plugin_runtime, map_tool_result};
use super::ui::ExtensionUiHandler;
use super::*;

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok()
}

mod command_runtime;
mod package_resources;
mod parsing;
