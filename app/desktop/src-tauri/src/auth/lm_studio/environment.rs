use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use super::{parsing::html_text, DesktopLmStudioEnvironment};

pub(super) fn lm_studio_environment() -> DesktopLmStudioEnvironment {
    let app_path = find_lm_studio_app_path();
    let app_version = app_path.as_deref().and_then(lm_studio_app_version);
    let home_path = find_lm_studio_home_dir();
    let bin_path = find_lm_studio_bin_dir();
    let lms_path = resolve_lms_path();
    let shell_path = shell_command_path("lms");
    let shell_config_paths = bin_path
        .as_deref()
        .map(shell_configs_containing_path)
        .unwrap_or_default();
    let cli_in_shell_path = shell_path.is_some() || !shell_config_paths.is_empty();
    let cli_version = lms_path
        .as_ref()
        .and_then(|resolved| lms_version(&resolved.path));
    let mut notes = Vec::new();

    if app_path.is_none() {
        notes.push("LM Studio.app was not found in /Applications or ~/Applications.".to_string());
    }
    if home_path.is_none() {
        notes.push(
            "LM Studio home was not found. Open LM Studio once so it creates its CLI files."
                .to_string(),
        );
    }
    if lms_path.is_none() {
        notes.push(
            "The lms CLI was not found. Use Add lms to PATH after opening LM Studio once."
                .to_string(),
        );
    } else if shell_path.is_none() {
        notes.push(
            "Kordi can use lms directly, but your shell PATH does not expose it yet.".to_string(),
        );
    }

    DesktopLmStudioEnvironment {
        app_path: app_path.map(path_to_string),
        app_version,
        home_path: home_path.map(path_to_string),
        bin_path: bin_path.map(path_to_string),
        cli_path: lms_path
            .as_ref()
            .map(|resolved| path_to_string(resolved.path.clone())),
        cli_version,
        cli_source: lms_path.map(|resolved| resolved.source),
        cli_in_shell_path,
        shell_config_paths: shell_config_paths.into_iter().map(path_to_string).collect(),
        notes,
    }
}

struct ResolvedCommandPath {
    path: PathBuf,
    source: String,
}

pub(super) fn lms_command() -> Result<Command, String> {
    let resolved = resolve_lms_path().ok_or_else(|| {
        "LM Studio CLI `lms` was not found. Open LM Studio once, then click Add lms to PATH in Kordi."
            .to_string()
    })?;
    Ok(Command::new(resolved.path))
}

fn resolve_lms_path() -> Option<ResolvedCommandPath> {
    if let Some(path) = find_lm_studio_bin_dir()
        .map(|dir| dir.join("lms"))
        .filter(|path| path.is_file())
    {
        return Some(ResolvedCommandPath {
            path,
            source: "lm-studio-home".to_string(),
        });
    }

    if let Some(path) = shell_command_path("lms") {
        return Some(ResolvedCommandPath {
            path,
            source: "shell-path".to_string(),
        });
    }

    for candidate in [
        "/opt/homebrew/bin/lms",
        "/usr/local/bin/lms",
        "/usr/bin/lms",
        "/bin/lms",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(ResolvedCommandPath {
                path,
                source: "common-path".to_string(),
            });
        }
    }

    None
}

fn find_lm_studio_home_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let pointer = home.join(".lmstudio-home-pointer");
    if let Ok(value) = fs::read_to_string(pointer) {
        let path = PathBuf::from(value.trim());
        if path.is_dir() {
            return Some(path);
        }
    }

    for candidate in [home.join(".cache/lm-studio"), home.join(".lmstudio")] {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    None
}

pub(super) fn find_lm_studio_bin_dir() -> Option<PathBuf> {
    let path = find_lm_studio_home_dir()?.join("bin");
    path.is_dir().then_some(path)
}

pub(super) fn find_lm_studio_app_path() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications/LM Studio.app")];
    if let Some(home) = home_dir() {
        candidates.push(home.join("Applications/LM Studio.app"));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn lm_studio_app_version(app_path: &Path) -> Option<String> {
    let info_plist = fs::read_to_string(app_path.join("Contents/Info.plist")).ok()?;
    plist_string_value(&info_plist, "CFBundleShortVersionString")
        .or_else(|| plist_string_value(&info_plist, "CFBundleVersion"))
}

fn plist_string_value(contents: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let tail = contents.split_once(&marker)?.1;
    let string_start = tail.find("<string>")? + "<string>".len();
    let string_tail = &tail[string_start..];
    let string_end = string_tail.find("</string>")?;
    let value = html_text(&string_tail[..string_end]);
    (!value.is_empty()).then_some(value)
}

fn lms_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    });
    let version = text.trim().lines().next().unwrap_or_default().trim();
    (!version.is_empty()).then(|| version.to_string())
}

fn shell_command_path(command: &str) -> Option<PathBuf> {
    let script = format!("command -v {command}");
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        let Ok(output) = Command::new(shell).arg("-lc").arg(&script).output() else {
            continue;
        };
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout);
            let path = value.trim().lines().next().unwrap_or_default().trim();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

pub(super) fn add_lm_studio_bin_to_shell_path(bin_path: &Path) -> Result<Vec<PathBuf>, String> {
    let home = home_dir().ok_or_else(|| "Unable to locate your home directory.".to_string())?;
    let targets = [".zshrc", ".bash_profile", ".bashrc", ".profile"];
    let mut existing = targets
        .iter()
        .map(|name| home.join(name))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    if existing.is_empty() {
        existing.push(home.join(".zshrc"));
    }

    let mut updated = Vec::new();
    let bin_value = bin_path.to_string_lossy();
    let line = format!("export PATH=\"$PATH:{bin_value}\"");

    for config_path in existing {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        if content.contains(bin_value.as_ref()) {
            continue;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config_path)
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        writeln!(file).ok();
        writeln!(file, "# Added by Kordi for LM Studio CLI (lms)")
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        writeln!(file, "{line}")
            .map_err(|err| format!("Unable to update {}: {err}", config_path.display()))?;
        updated.push(config_path);
    }

    Ok(updated)
}

fn shell_configs_containing_path(bin_path: &Path) -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let bin_value = bin_path.to_string_lossy();
    [".zshrc", ".bash_profile", ".bashrc", ".profile"]
        .iter()
        .map(|name| home.join(name))
        .filter(|path| {
            fs::read_to_string(path).is_ok_and(|content| content.contains(bin_value.as_ref()))
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_string_value_decodes_html_entities() {
        assert_eq!(
            plist_string_value(
                "<key>CFBundleVersion</key><string>1&amp;2</string>",
                "CFBundleVersion",
            ),
            Some("1&2".to_string()),
        );
    }
}
