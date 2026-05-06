use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const SUPER_COLLABORATION_SKILL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../skills/super-collaboration/SKILL.md"
));

pub(crate) fn bundled_skill_root(cwd: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    cwd.to_string_lossy().hash(&mut hasher);
    let cwd_hash = hasher.finish();

    std::env::temp_dir()
        .join("kordi")
        .join("bundled-skills")
        .join(env!("CARGO_PKG_VERSION"))
        .join(format!("{cwd_hash:016x}"))
}

pub(crate) fn ensure_bundled_skills(cwd: &Path) -> Result<PathBuf> {
    let root = bundled_skill_root(cwd);
    write_bundled_skill(&root, "super-collaboration", SUPER_COLLABORATION_SKILL)?;
    Ok(root)
}

fn write_bundled_skill(root: &Path, name: &str, content: &str) -> Result<()> {
    let skill_dir = root.join(name);
    std::fs::create_dir_all(&skill_dir)
        .with_context(|| format!("create bundled skill directory {}", skill_dir.display()))?;

    let skill_path = skill_dir.join("SKILL.md");
    let desired = content.to_string();
    let should_write = match std::fs::read_to_string(&skill_path) {
        Ok(existing) => existing != desired,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => return Err(err).with_context(|| format!("read {}", skill_path.display())),
    };

    if should_write {
        let temp_path = skill_path.with_extension(format!("tmp.{}", std::process::id()));
        std::fs::write(&temp_path, desired)
            .with_context(|| format!("write bundled skill {}", temp_path.display()))?;
        std::fs::rename(&temp_path, &skill_path).with_context(|| {
            format!(
                "move bundled skill {} to {}",
                temp_path.display(),
                skill_path.display()
            )
        })?;
    }

    Ok(())
}
