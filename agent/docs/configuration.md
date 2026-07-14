# Configuration

Kordi uses a layered configuration system. Project settings override global settings.

Kordi now prefers `.kordi` paths for config/resources. Legacy agent paths are still read and are migrated when the new target does not already exist.

## Role in Kordi

Use this document when you need the configuration contract for the Kordi agent layer.

It is the reference for:

- file locations
- settings structure
- model and provider defaults
- runtime behavior toggles

For the broader agent development flow, see [development.md](development.md).

## File Locations

| File | Purpose |
|------|---------|
| `~/.kordi/settings.json` | Global settings |
| `<project>/.kordi/settings.json` | Project-local settings |
| `~/.kordi/AGENTS.md` | Global system prompt additions |
| `<project>/AGENTS.md` | Project system prompt additions |
| `~/.kordi/auth.json` | Stored API keys and OAuth tokens |
| `~/.kordi/sessions.db` | Session database |
| `~/.kordi/system-prompts/` | Named system prompt templates |
| `~/.kordi/skills/` | Global skills |
| `~/.kordi/extensions/` | Global extensions |
| `~/.kordi/prompts/` | Global prompt templates |

Project root is detected by walking up from `cwd` looking for `.git`, `Cargo.toml`, `package.json`, `go.mod`, `pyproject.toml`, `.hg`, `AGENTS.md`, or `CLAUDE.md`.

## settings.json Reference

```json
{
  "execution_mode": "safety",
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-20250514",
  "default_thinking": "medium",
  "execution_mode": "safety",

  "compaction": {
    "enabled": true,
    "reserve_tokens": 16384,
    "keep_recent_tokens": 20000
  },

  "retry": {
    "enabled": true,
    "max_retries": 3,
    "base_delay_ms": 2000,
    "max_delay_ms": 60000
  },

  "tools": null,
  "extensions": [],
  "skills": [],
  "prompts": [],
  "packages": [],

  "enable_skill_commands": true,

  "models": [
    {
      "id": "my-local-model",
      "name": "My Local Model",
      "provider": "ollama",
      "api": "openai",
      "base_url": "http://localhost:11434/v1",
      "context_window": 32000,
      "max_tokens": 4096,
      "reasoning": false
    }
  ],

  "providers": [
    {
      "name": "custom",
      "base_url": "https://my-api.example.com/v1",
      "api_key_env": "MY_API_KEY",
      "api": "openai",
      "headers": {
        "X-Custom-Header": "value"
      }
    }
  ],

  "color_theme": "lavender",
  "compatibility_mode": false,

  "update_check": {
    "enabled": true,
    "ttl_hours": 24
  },

  "storage": {
    "root_dir": "~/.kordi",
    "db_path": "~/.kordi/sessions.db",
    "artifacts_dir": "~/.kordi/artifacts"
  }
}
```

### Fields

#### `execution_mode`
Execution posture for built-in tools.

- `safety` (default)
  - restricts built-in `write` and `edit` to files inside the active workspace
  - runs `bash` in the safer approval/sandboxed posture
- `yolo`
  - allows broader built-in file mutation behavior
  - skips the safer bash posture

Kordi shows the active posture in `/session` and the TUI footer/settings UI so it stays visible during a run.

#### `default_provider`
Default LLM provider. Values: `anthropic`, `openai`, `google`, `groq`, `xai`, `openrouter`, or a custom provider name.

#### `default_model`
Default model ID. Can also be set via `--model` CLI flag.

#### `default_thinking`
Default thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Controls extended thinking for supported models; Kordi limits the selectable levels to those supported by the active model and authentication route.

#### `compaction`
Automatic context compaction when approaching the model's context window limit.
- `enabled` — enable/disable compaction
- `reserve_tokens` — tokens to keep free for the next response
- `keep_recent_tokens` — always keep this many tokens of recent context

#### `retry`
Auto-retry on transient provider errors (429, 500, 502, 503, etc.).
- `max_retries` — maximum retry attempts
- `base_delay_ms` — initial backoff delay
- `max_delay_ms` — maximum backoff delay (also caps server-requested delays)

#### `tools`
Restrict which built-in tools are available. `null` means all tools enabled. Example: `["read", "bash", "edit", "write"]`

#### `extensions`
Paths to JS/TS extension files or directories. Loaded at startup.

#### `skills`
Additional paths to scan for skill files.

#### `prompts`
Additional paths to scan for prompt template files.

#### `packages`
Installed package sources. Managed via `kordi install`, `kordi remove`, `kordi update`.

#### `models`
Custom model definitions. Fields:
- `id` (required) — model identifier
- `provider` (required) — which provider handles this model
- `api` — API type: `openai`, `anthropic`, `google`
- `base_url` — custom API endpoint
- `context_window` — context window size in tokens
- `max_tokens` — max output tokens
- `reasoning` — whether model supports extended thinking

#### `providers`
Custom provider overrides. Fields:
- `name` (required) — provider name
- `base_url` — API endpoint URL
- `api_key_env` — environment variable name for the API key
- `api` — API type
- `headers` — additional HTTP headers

#### `color_theme`
TUI color theme. Currently supported: `lavender` (default), or custom.

#### `storage`
Optional storage path overrides.

- `root_dir` — shared base directory for Kordi-managed runtime data
- `db_path` — explicit session database path override
- `artifacts_dir` — explicit default artifacts directory override

Defaults stay outside the repo by default. Project-local `.kordi/` paths are used for project-scoped settings/resources, not for the default global DB/artifact store unless you explicitly configure them.

#### `compatibility_mode`
Enable ASCII-safe fallback rendering for terminals/fonts that do not display Kordi's richer Unicode glyphs correctly.

When enabled, Kordi uses safer fallback symbols for spinner frames, live tool markers, and some transcript decorations.

Equivalent environment variable:

```bash
KORDI_TUI_COMPAT=1
```

## Migration Notes

- Kordi now prefers `~/.kordi/` and `<project>/.kordi/` for config/resources.
- Legacy agent locations are still discovered.
- When the new target does not already exist, Kordi migrates legacy settings and resource directories into the new location.
- Global runtime/storage files such as `auth.json`, `sessions.db`, `artifacts/`, and caches are migrated into the resolved storage root derived from `storage` settings when applicable.
- If both the new and legacy locations exist, Kordi prefers the new location and leaves the legacy copy untouched.
- `execution_mode` now defaults to `yolo`.
- Use `"execution_mode": "safety"` if you want built-in `write` or `edit` restricted to the current project directory.
- In `safety` mode, non-read-only bash commands now go through the safer approval/sandboxed path instead of running freely.

## AGENTS.md

`AGENTS.md` (or `CLAUDE.md` as fallback) files are appended to the system prompt. Kordi loads them from multiple levels and merges them:

1. `~/.kordi/AGENTS.md` — global rules
2. From project root down to cwd, each `AGENTS.md` found — project rules

Files are joined with `---` separators, global first.

### Example

```markdown
# Project Rules
- This is a Rust project using the 2024 edition
- Always run `cargo test` after changes
- Prefer explicit error handling over unwrap()
```

## System Prompt Templates

Save `.md` files in `~/.kordi/system-prompts/`:

```
~/.kordi/system-prompts/
├── coding.md
├── research.md
└── review.md
```

Use with:
```bash
kordi -t coding       # Use the "coding" template
kordi --list-templates # List all available templates
```

Templates fully replace the default system prompt when used.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Google AI API key |
| `GROQ_API_KEY` | Groq API key |
| `XAI_API_KEY` | xAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `KORDI_BROWSER` | Path to Chrome/Chromium binary for `browser_fetch` |
| `KORDI_TUI_COMPAT` | Enable ASCII-safe TUI compatibility mode |

## Related docs

- [README.md](README.md)
- [development.md](development.md)
- [providers.md](providers.md)
- [extensions.md](extensions.md)
