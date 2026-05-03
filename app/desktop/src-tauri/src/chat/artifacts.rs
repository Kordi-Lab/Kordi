use std::path::{Component, Path, PathBuf};

use super::{
    chat_cwd, expand_home_project_path, DesktopArtifactDirectory, DesktopArtifactDirectoryEntry,
    DesktopChatArtifactPreview, DesktopChatArtifactPreviewLine,
};

fn artifact_base_path(base_root: Option<&str>) -> Result<PathBuf, String> {
    base_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home_project_path)
        .map(Ok)
        .unwrap_or_else(chat_cwd)
}

fn project_root_is_set(base_root: Option<&str>) -> bool {
    base_root
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn ensure_artifact_path_within_base(
    resolved_path: PathBuf,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    if !project_root_is_set(base_root) {
        return Ok(resolved_path);
    }

    let base_path = artifact_base_path(base_root)?;
    let base_path =
        std::fs::canonicalize(&base_path).unwrap_or_else(|_| normalize_path_lexically(&base_path));
    let canonical_path = std::fs::canonicalize(&resolved_path)
        .unwrap_or_else(|_| normalize_path_lexically(&resolved_path));
    if !canonical_path.starts_with(&base_path) {
        return Err(format!(
            "Artifact path is outside the project root: {}",
            resolved_path.display()
        ));
    }

    Ok(resolved_path)
}

fn resolve_artifact_preview_path(
    raw_path: &str,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Artifact path is required".to_string());
    }

    let candidate = expand_home_project_path(trimmed);
    let resolved_path = if candidate.is_absolute() {
        candidate
    } else {
        artifact_base_path(base_root)?.join(candidate)
    };

    ensure_artifact_path_within_base(resolved_path, base_root)
}

fn resolve_artifact_directory_path(
    raw_path: Option<&str>,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    let base = artifact_base_path(base_root)?;
    let Some(trimmed) = raw_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(base);
    };

    let candidate = expand_home_project_path(trimmed);
    if candidate.is_absolute() {
        Ok(candidate)
    } else {
        Ok(base.join(candidate))
    }
}

fn artifact_file_kind(path: &Path) -> &'static str {
    let Some(extension) = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
    else {
        return "file";
    };
    match extension.as_str() {
        "c" | "cc" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "html" | "java" | "js"
        | "json" | "jsx" | "kt" | "mjs" | "php" | "py" | "rb" | "rs" | "scss" | "sh" | "sql"
        | "swift" | "toml" | "ts" | "tsx" | "vue" | "xml" | "yaml" | "yml" => "code",
        "adoc" | "csv" | "ipynb" | "markdown" | "md" | "mdx" | "pdf" | "rst" | "rtf" | "txt" => {
            "document"
        }
        _ => "file",
    }
}

#[tauri::command]
pub async fn desktop_chat_artifact_preview(
    path: String,
    base_root: Option<String>,
) -> Result<DesktopChatArtifactPreview, String> {
    const MAX_PREVIEW_BYTES: usize = 64 * 1024;
    const MAX_PREVIEW_LINES: usize = 400;

    let resolved_path = resolve_artifact_preview_path(&path, base_root.as_deref())?;
    let bytes = std::fs::read(&resolved_path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("Artifact file not found: {}", resolved_path.display())
        } else {
            format!(
                "Unable to read artifact preview for {}: {err}",
                resolved_path.display()
            )
        }
    })?;
    let mut truncated = bytes.len() > MAX_PREVIEW_BYTES;
    let preview_bytes = if truncated {
        &bytes[..MAX_PREVIEW_BYTES]
    } else {
        bytes.as_slice()
    };
    let preview_text = String::from_utf8_lossy(preview_bytes).into_owned();

    if preview_text.contains('\u{0000}') {
        return Err(
            "This artifact looks like a binary file and can't be previewed here.".to_string(),
        );
    }

    let mut lines = Vec::new();
    if !preview_text.is_empty() {
        for (index, line) in preview_text.split('\n').enumerate() {
            if index >= MAX_PREVIEW_LINES {
                truncated = true;
                break;
            }

            lines.push(DesktopChatArtifactPreviewLine {
                number: index + 1,
                text: line.strip_suffix('\r').unwrap_or(line).to_string(),
            });
        }
    }

    Ok(DesktopChatArtifactPreview {
        path: resolved_path.display().to_string(),
        lines,
        truncated,
    })
}

#[tauri::command]
pub async fn desktop_chat_artifact_directory(
    path: Option<String>,
    base_root: Option<String>,
) -> Result<DesktopArtifactDirectory, String> {
    const MAX_DIRECTORY_ENTRIES: usize = 500;

    let requested_path = resolve_artifact_directory_path(path.as_deref(), base_root.as_deref())?;
    let directory_path = if requested_path.is_file() {
        requested_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Artifact file has no parent folder".to_string())?
    } else {
        requested_path
    };
    if !directory_path.exists() {
        return Err(format!("Folder not found: {}", directory_path.display()));
    }
    if !directory_path.is_dir() {
        return Err(format!(
            "Path is not a folder: {}",
            directory_path.display()
        ));
    }

    let directory_path = std::fs::canonicalize(&directory_path).unwrap_or(directory_path);
    let base_path = artifact_base_path(base_root.as_deref())?;
    let base_path = std::fs::canonicalize(&base_path).unwrap_or(base_path);
    let has_project_root = project_root_is_set(base_root.as_deref());
    if has_project_root && !directory_path.starts_with(&base_path) {
        return Err(format!(
            "Folder is outside the project root: {}",
            directory_path.display()
        ));
    }
    let parent_path = directory_path.parent().and_then(|parent| {
        if directory_path == base_path || !parent.starts_with(&base_path) {
            None
        } else {
            Some(parent.display().to_string())
        }
    });

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory_path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().trim().to_string();
        if name.is_empty() || name == ".DS_Store" {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        let is_directory = metadata.is_dir();
        entries.push(DesktopArtifactDirectoryEntry {
            name,
            path: entry_path.display().to_string(),
            kind: if is_directory {
                "directory"
            } else {
                artifact_file_kind(&entry_path)
            }
            .to_string(),
            is_directory,
            size_bytes: (!is_directory).then_some(metadata.len()),
        });
    }

    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries.truncate(MAX_DIRECTORY_ENTRIES);

    Ok(DesktopArtifactDirectory {
        path: directory_path.display().to_string(),
        parent_path,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_lexically_removes_current_dir_and_parent_segments() {
        assert_eq!(
            normalize_path_lexically(Path::new("/tmp/project/./src/../README.md")),
            PathBuf::from("/tmp/project/README.md"),
        );
    }

    #[test]
    fn artifact_file_kind_recognizes_code_extensions() {
        assert_eq!(artifact_file_kind(Path::new("main.rs")), "code");
        assert_eq!(artifact_file_kind(Path::new("notes.md")), "document");
    }
}
