mod agents_md;
mod compaction_exec;
#[allow(dead_code, unused_imports)]
mod extensions;
mod input_files;
mod live_models;
#[allow(dead_code)]
mod reflection_runtime;
mod runtime_model;
pub mod scheduled_tasks_runtime;
#[allow(dead_code)]
mod session_bootstrap;
#[allow(dead_code)]
mod session_info;
#[allow(dead_code)]
mod slash;
pub mod task_operator;
mod tool_registry;
pub mod turn_runner;

pub mod desktop_runtime;
pub mod login;
pub mod oauth;
pub mod skill_library;

#[derive(Clone, Debug, Default)]
pub struct Cli {
    pub command: Option<Commands>,
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Option<String>,
    pub system_prompt_template: Option<String>,
    pub list_templates: bool,
    pub thinking: Option<String>,
    pub print: bool,
    pub r#continue: bool,
    pub resume: bool,
    pub no_session: bool,
    pub session: Option<String>,
    pub tools: Option<String>,
    pub no_tools: bool,
    pub list_models: Option<Option<String>>,
    pub models: Option<String>,
    pub extensions: Vec<String>,
    pub verbose: bool,
    pub messages: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum Commands {}
