use std::path::Path;

use super::Settings;

impl Settings {
    // IO boundary — should migrate to cli
    /// Load global settings from `~/.kordi/settings.json`, with legacy
    /// global settings fallback.
    pub fn load_global() -> Self {
        let _ = crate::config::migrate_legacy_global_config();
        let path = crate::config::global_settings_path();
        match Self::load_from_file_result(&path) {
            Ok(settings) => {
                let _ = crate::config::migrate_legacy_global_storage(&settings.storage);
                settings
            }
            Err(error) => {
                eprintln!(
                    "Warning: failed to load settings from {}: {error}",
                    path.display()
                );
                let settings = Self::default();
                let _ = crate::config::migrate_legacy_global_storage(&settings.storage);
                settings
            }
        }
    }

    /// Save global settings to `~/.kordi/settings.json`.
    pub fn save_global(&self) -> std::io::Result<()> {
        let _ = crate::config::migrate_legacy_global_config();
        self.save_to_file(&crate::config::preferred_global_settings_path())
    }

    /// Save project settings to the detected project root's `.kordi/settings.json`.
    /// Falls back to `<cwd>/.kordi/settings.json` when no project root markers are found.
    pub fn save_project(&self, cwd: &Path) -> std::io::Result<()> {
        let _ = crate::config::migrate_legacy_project_config(cwd);
        self.save_to_file(&crate::config::preferred_project_settings_path(cwd))
    }

    /// Save settings to a specific file path.
    pub fn save_to_file(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(path, content)
    }

    // IO boundary — should migrate to cli
    /// Load project-local settings from the detected project root's
    /// `.kordi/settings.json`, with legacy project settings fallback.
    /// Falls back to `<cwd>/.kordi/settings.json` when no project root markers are found.
    pub fn load_project(cwd: &Path) -> Self {
        let _ = crate::config::migrate_legacy_project_config(cwd);
        let path = crate::config::project_settings_path(cwd);
        Self::load_from_file(&path)
    }

    // IO boundary — should migrate to cli
    /// Load settings from a specific file path.
    pub fn load_from_file_result(path: &Path) -> std::io::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(content) => Self::parse_result(&content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    /// Load settings from a specific file path, defaulting on errors.
    /// Prefer `load_from_file_result()` when callers need to surface malformed config.
    pub fn load_from_file(path: &Path) -> Self {
        match Self::load_from_file_result(path) {
            Ok(settings) => settings,
            Err(error) => {
                eprintln!(
                    "Warning: failed to load settings from {}: {error}",
                    path.display()
                );
                Self::default()
            }
        }
    }

    // IO boundary — should migrate to cli
    /// Convenience: load global + project and merge.
    pub fn load_merged(cwd: &Path) -> Self {
        let global = Self::load_global();
        let project = Self::load_project(cwd);
        Self::merge(&global, &project)
    }
}
