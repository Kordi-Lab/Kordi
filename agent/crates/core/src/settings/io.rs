use std::path::Path;

use super::{MemorySettings, Settings};

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

    /// Save global settings to `~/.kordi/settings.json`. The write is atomic
    /// (see `save_to_file`).
    pub fn save_global(&self) -> std::io::Result<()> {
        let _ = crate::config::migrate_legacy_global_config();
        self.save_to_file(&crate::config::preferred_global_settings_path())
    }

    /// Load the global settings file, apply `patch` to its memory block, save
    /// it, and return the new block. Unlike `load_global`, a malformed file is
    /// an error so the update never overwrites settings it could not read.
    pub fn update_global_memory(
        patch: impl FnOnce(&mut MemorySettings),
    ) -> std::io::Result<MemorySettings> {
        let _ = crate::config::migrate_legacy_global_config();
        let mut settings = Self::load_from_file_result(&crate::config::global_settings_path())?;
        patch(&mut settings.memory);
        settings.save_global()?;
        Ok(settings.memory)
    }

    /// Save project settings to the detected project root's `.kordi/settings.json`.
    /// Falls back to `<cwd>/.kordi/settings.json` when no project root markers are found.
    pub fn save_project(&self, cwd: &Path) -> std::io::Result<()> {
        let _ = crate::config::migrate_legacy_project_config(cwd);
        self.save_to_file(&crate::config::preferred_project_settings_path(cwd))
    }

    /// Save settings to a specific file path. Writes a sibling temporary
    /// file and renames it over the target, so a crash leaves either the old
    /// or the new file, never a partial one.
    pub fn save_to_file(&self, path: &Path) -> std::io::Result<()> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let content = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings.json");
        let temp_path = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        if let Err(error) = std::fs::write(&temp_path, content) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }
        std::fs::rename(&temp_path, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp_path);
        })
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
