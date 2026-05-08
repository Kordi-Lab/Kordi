# RTK output optimization

Kordi can optionally route `bash` tool commands through [RTK](https://github.com/rtk-ai/rtk/tree/master) to compact common developer command output before it is stored in a session or sent back to a model.

## Enable

Install `rtk` so it is available on `PATH`, then start Kordi with either environment variable:

```bash
KORDI_BASH_RTK=1 kordi
# or
KORDI_RTK_ENABLED=1 kordi
```

Truthy values are `1`, `true`, `yes`, and `on`.

When enabled, Kordi runs `rtk --version` before each optimized shell command. If RTK is missing or version detection fails, Kordi falls back to the raw `bash` command instead of failing the session.

## Bypass for raw output

The `bash` tool accepts a `raw: true` parameter. Use it to rerun a command without RTK when compacted output hides detail needed for debugging.

## Visibility

Bash tool details include `outputOptimization`, for example:

```json
{
  "outputOptimization": {
    "provider": "rtk",
    "enabled": true,
    "applied": true,
    "version": "rtk 1.2.3"
  }
}
```

Fallbacks include `fallbackReason` so the UI/model can explain why raw output was used.

## Limitations

- RTK is opt-in and only affects the `bash` tool.
- Kordi does not bundle RTK; users must install it separately.
- Safety-mode sandboxed bash commands are left raw for now.
- Native Kordi output caps still apply after RTK optimization.
