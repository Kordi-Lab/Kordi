use super::*;

/// Only an unambiguous, explicitly written directory reference selects a workspace.
/// This must only be called after establishing owner authority.
pub(crate) fn referenced_workspace(text: &str, cwd: &Path) -> Option<PathBuf> {
    let mut directories = Vec::new();
    let mut consumed = 0;
    for (index, _) in text.match_indices('@') {
        if index < consumed || !is_at_reference_boundary(text, index) {
            continue;
        }
        let Some((end, raw)) = parse_at_reference(text, index, cwd) else {
            continue;
        };
        consumed = end;
        if !raw.contains('/') && raw != "~" {
            continue;
        }
        let path = resolve_reference_path(&raw, cwd);
        if path.is_dir()
            && let Ok(path) = std::fs::canonicalize(path)
            && !directories.contains(&path)
        {
            directories.push(path);
        }
    }
    (directories.len() == 1).then(|| directories.remove(0))
}
