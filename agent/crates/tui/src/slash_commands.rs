use crate::select_list::SelectItem;

pub use kordi_core::slash_commands::{
    SlashCommandSpec, install_help_lines, matches_shared_local_slash_submission,
    shared_slash_command_help_lines, shared_slash_commands,
};

pub fn shared_slash_command_select_items() -> Vec<SelectItem> {
    shared_slash_commands()
        .iter()
        .map(|spec| SelectItem {
            label: spec.command.to_string(),
            detail: Some(spec.menu_detail.to_string()),
            value: spec.command.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        matches_shared_local_slash_submission, shared_slash_command_help_lines,
        shared_slash_command_select_items,
    };

    #[test]
    fn shared_registry_contains_copy_command() {
        let commands = shared_slash_command_select_items();
        assert!(commands.iter().any(|item| item.value == "/copy"));
        assert!(commands.iter().any(|item| item.value == "/exit"));
    }

    #[test]
    fn help_lines_include_argument_forms() {
        let help = shared_slash_command_help_lines().join("\n");
        assert!(help.contains("/model [name]"));
        assert!(help.contains("/name <name>"));
        assert!(help.contains("/install [-l|--local] <source>"));
        assert!(help.contains("npm:kordi-example-skill"));
        assert!(help.contains("/update"));
        assert!(help.contains("/exit"));
    }

    #[test]
    fn submission_match_handles_argument_forms() {
        assert!(matches_shared_local_slash_submission("/model claude"));
        assert!(matches_shared_local_slash_submission("/name demo"));
        assert!(matches_shared_local_slash_submission("/install npm:demo"));
        assert!(matches_shared_local_slash_submission("/update"));
        assert!(matches_shared_local_slash_submission("/exit"));
        assert!(!matches_shared_local_slash_submission("/help extra"));
        assert!(!matches_shared_local_slash_submission("/exit now"));
    }
}
