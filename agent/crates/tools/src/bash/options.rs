use super::*;

pub(super) fn resolve(params: &Value, ctx: &ToolContext) -> KordiResult<std::path::PathBuf> {
    crate::ensure_tool_allowed(&BashTool, ctx)?;
    let mut workdir = ctx.cwd.clone();
    if let Some(value) = params.get("workdir").and_then(Value::as_str) {
        let directory = crate::path::resolve_path(&ctx.cwd, value);
        crate::path::ensure_write_allowed(ctx, &directory, "Changing command working directory")?;
        workdir = std::fs::canonicalize(&directory).map_err(|_| {
            KordiError::Tool(
                "Command workdir does not exist or cannot be accessed on this device.".into(),
            )
        })?;
        if !workdir.is_dir() {
            return Err(KordiError::Tool(
                "Command workdir must be a directory.".into(),
            ));
        }
    }
    Ok(workdir)
}

pub(super) fn timeout(params: &Value) -> KordiResult<Option<std::time::Duration>> {
    let timeout_raw = params.get("timeout").and_then(|v| v.as_f64());
    if let Some(timeout) = timeout_raw
        && (!timeout.is_finite() || timeout <= 0.0)
    {
        return Err(KordiError::Tool("bash timeout must be > 0".into()));
    }
    let timeout_secs = timeout_raw.map(std::time::Duration::from_secs_f64);
    Ok(timeout_secs)
}

pub(super) fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "command": { "type": "string", "description": "Bash command to execute" },
            "workdir": { "type": "string", "description": "Optional working directory on this device; supports ~ and paths relative to the session workspace." },
            "timeout": { "type": "number", "description": "Timeout in seconds (optional, no default timeout)" },
            "raw": { "type": "boolean", "description": "Bypass optional RTK output optimization and return raw command output (default: false)" }
        },
        "required": ["command"]
    })
}
