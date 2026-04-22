use bb_core::settings::Settings;
use std::path::{Path, PathBuf};

pub(crate) const WORKSPACE_API_BASE_URL_ENV: &str = "KORDI_WORKSPACE_API_BASE_URL";
pub(crate) const WORKSPACE_SESSION_SCOPE_KEY_ENV: &str = "KORDI_WORKSPACE_SESSION_SCOPE_KEY";
pub(crate) const WORKSPACE_LOCATOR_ENV: &str = "KORDI_WORKSPACE_LOCATOR";
pub(crate) const WORKSPACE_ENVIRONMENT_KIND_ENV: &str = "KORDI_WORKSPACE_ENVIRONMENT_KIND";
pub(crate) const WORKSPACE_DISABLE_EXTENSIONS_ENV: &str = "KORDI_WORKSPACE_DISABLE_EXTENSIONS";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceEnvironmentKind {
    Local,
    Ssh,
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceContext {
    launch_cwd: PathBuf,
    session_scope_key: String,
    workspace_display_path: String,
    workspace_api_base_url: Option<String>,
    environment_kind: WorkspaceEnvironmentKind,
    disable_extensions: bool,
}

impl WorkspaceContext {
    pub(crate) fn from_env(launch_cwd: PathBuf) -> Self {
        let workspace_api_base_url = env_string(WORKSPACE_API_BASE_URL_ENV);
        let session_scope_key = env_string(WORKSPACE_SESSION_SCOPE_KEY_ENV);
        let workspace_display_path = env_string(WORKSPACE_LOCATOR_ENV);
        let environment_kind = env_string(WORKSPACE_ENVIRONMENT_KIND_ENV);
        let remote_requested = workspace_api_base_url.is_some()
            || session_scope_key.is_some()
            || workspace_display_path.is_some()
            || environment_kind.is_some();

        let environment_kind = if remote_requested {
            match environment_kind.as_deref() {
                Some("ssh") => WorkspaceEnvironmentKind::Ssh,
                Some(kind) if !kind.is_empty() => WorkspaceEnvironmentKind::Other(kind.to_string()),
                _ => WorkspaceEnvironmentKind::Other("remote".to_string()),
            }
        } else {
            WorkspaceEnvironmentKind::Local
        };

        let default_scope = launch_cwd.display().to_string();
        let default_display = launch_cwd.display().to_string();

        Self {
            launch_cwd,
            session_scope_key: session_scope_key.unwrap_or(default_scope),
            workspace_display_path: workspace_display_path.unwrap_or(default_display),
            workspace_api_base_url,
            environment_kind,
            disable_extensions: remote_requested || env_flag(WORKSPACE_DISABLE_EXTENSIONS_ENV),
        }
    }

    #[cfg(test)]
    pub(crate) fn local(launch_cwd: PathBuf) -> Self {
        Self {
            session_scope_key: launch_cwd.display().to_string(),
            workspace_display_path: launch_cwd.display().to_string(),
            launch_cwd,
            workspace_api_base_url: None,
            environment_kind: WorkspaceEnvironmentKind::Local,
            disable_extensions: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn ssh(
        launch_cwd: PathBuf,
        session_scope_key: impl Into<String>,
        workspace_display_path: impl Into<String>,
        workspace_api_base_url: Option<String>,
    ) -> Self {
        Self {
            launch_cwd,
            session_scope_key: session_scope_key.into(),
            workspace_display_path: workspace_display_path.into(),
            workspace_api_base_url,
            environment_kind: WorkspaceEnvironmentKind::Ssh,
            disable_extensions: true,
        }
    }

    pub(crate) fn launch_cwd(&self) -> &Path {
        &self.launch_cwd
    }

    pub(crate) fn session_scope_key(&self) -> &str {
        &self.session_scope_key
    }

    #[allow(dead_code)]
    pub(crate) fn workspace_display_path(&self) -> &str {
        &self.workspace_display_path
    }

    #[allow(dead_code)]
    pub(crate) fn environment_kind_key(&self) -> String {
        match &self.environment_kind {
            WorkspaceEnvironmentKind::Local => "local".to_string(),
            WorkspaceEnvironmentKind::Ssh => "ssh".to_string(),
            WorkspaceEnvironmentKind::Other(kind) => kind.trim().to_ascii_lowercase(),
        }
    }

    pub(crate) fn workspace_api_base_url_owned(&self) -> Option<String> {
        self.workspace_api_base_url.clone()
    }

    pub(crate) fn is_remote(&self) -> bool {
        !matches!(self.environment_kind, WorkspaceEnvironmentKind::Local)
    }

    pub(crate) fn disable_extensions(&self) -> bool {
        self.disable_extensions
    }

    pub(crate) fn load_merged_settings(&self) -> Settings {
        if self.is_remote() {
            Settings::load_global()
        } else {
            Settings::load_merged(&self.launch_cwd)
        }
    }

    pub(crate) fn load_project_settings(&self) -> Option<Settings> {
        (!self.is_remote()).then(|| Settings::load_project(&self.launch_cwd))
    }

    pub(crate) fn environment_label(&self) -> String {
        match &self.environment_kind {
            WorkspaceEnvironmentKind::Local => "Local".to_string(),
            WorkspaceEnvironmentKind::Ssh => "SSH remote".to_string(),
            WorkspaceEnvironmentKind::Other(kind) => format!("{kind} remote"),
        }
    }

    pub(crate) fn environment_prompt_section(&self) -> String {
        if !self.is_remote() {
            return String::new();
        }

        format!(
            "\n\n## Active environment\n- Environment: {}\n- Workspace root: {}\n- `@file` references resolve against this workspace\n- Use workspace-relative paths with read, ls, grep, and find\n- Filesystem reads are routed through the active workspace API",
            self.environment_label(),
            self.workspace_display_path,
        )
    }

    #[allow(dead_code)]
    pub(crate) fn display_footer_label(&self) -> String {
        if self.is_remote() {
            format!(
                "{} • {}",
                self.environment_label(),
                self.workspace_display_path
            )
        } else {
            self.workspace_display_path.clone()
        }
    }
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_workspace_context_uses_launch_cwd_for_scope_and_display() {
        let cwd = PathBuf::from("/tmp/kordi-local");
        let context = WorkspaceContext::local(cwd.clone());
        assert_eq!(context.launch_cwd(), cwd.as_path());
        assert_eq!(context.session_scope_key(), "/tmp/kordi-local");
        assert_eq!(context.workspace_display_path(), "/tmp/kordi-local");
        assert!(!context.is_remote());
        assert!(!context.disable_extensions());
    }

    #[test]
    fn ssh_workspace_context_reports_remote_prompt_section() {
        let context = WorkspaceContext::ssh(
            PathBuf::from("/tmp/kordi-launch"),
            "ssh:prod-kordi:/srv/prod/kordi",
            "/srv/prod/kordi",
            Some("http://127.0.0.1:7080".to_string()),
        );
        assert!(context.is_remote());
        assert!(context.disable_extensions());
        assert_eq!(context.environment_label(), "SSH remote");
        assert!(
            context
                .environment_prompt_section()
                .contains("/srv/prod/kordi")
        );
        assert!(context.display_footer_label().contains("SSH remote"));
    }
}
