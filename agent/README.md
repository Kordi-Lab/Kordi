# Kordi Agent Runtime

![Kordi agent runtime title figure](assets/title-figure.png)

A Rust-native AI coding agent for the terminal — featuring a TUI, multi-provider support, tool use, session persistence, branching, extensions, and skills.

## Role in Kordi

Inside the Kordi monorepo, this directory is the source-of-truth for the local agent runtime.

It owns:

- runtime execution
- provider and model integration
- sessions and persistence
- tools and extensions
- terminal UX

## Monorepo commands

Run these from the repository root:

```bash
cd /path/to/kordi
pnpm run:agent -- --help
pnpm check:agent
pnpm build:agent
```

Direct Rust entrypoints also work:

```bash
cd /path/to/kordi
cargo run -p kordi-cli --
```

## Directory guide

Core workspace crates:

| Path | Purpose |
|------|---------|
| `crates/core` | Core runtime types and orchestration |
| `crates/session` | Session persistence and context management |
| `crates/tools` | Built-in tool implementations |
| `crates/provider` | Provider and model integrations |
| `crates/tui` | Terminal user interface |
| `crates/cli` | Main `kordi` binary |

## Validation in Kordi

```bash
cd /path/to/kordi
pnpm check:agent
pnpm build:agent
```

See [../README.md](../README.md) for the monorepo overview and [../docs/development.md](../docs/development.md) for the shared command map.
For deeper agent-specific references, see [docs/README.md](docs/README.md).

## Install

Build from source for development or local use.

Requires [Rust](https://rustup.rs). Install Rust first if you don't have it:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Then build and install the runtime from source:

```bash
git clone https://github.com/Kordi-AI/Kordi.git kordi
cd kordi
cargo install --path agent/crates/cli
```

This compiles the `kordi` binary and installs it to `~/.cargo/bin/kordi` (which Rust adds to your PATH).

## Getting Started

### 1. Start the TUI

```bash
kordi
```

That's the recommended way to get started.

### 2. Log in with `/login`

Inside the TUI, run:

```text
/login
```

This opens the provider picker and auth flow directly in the TUI.

If you prefer, you can also log in from a normal terminal:

```bash
kordi login              # Interactive provider selection
kordi login anthropic    # Login to Anthropic (OAuth)
kordi login openai-codex # Login to OpenAI (OAuth)
kordi login google       # Login to Google (API key)
```

Or set environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, etc.

That's it! Run `kordi` to launch the interactive TUI. Type your prompt and press Enter.

### More ways to use `kordi`

```bash
kordi                                    # Launch the TUI
kordi "Explain this codebase"            # TUI with an initial prompt
kordi -p "What is 2+2?"                  # Print mode (non-interactive, pipe-friendly)
kordi -c                                 # Continue your last session
kordi -r                                 # Resume: pick from previous sessions
kordi --model sonnet                     # Use a specific model
kordi --model sonnet:high                # Model with extended thinking
kordi --list-models                      # List all available models
```

## Features

- **TUI** — rich terminal interface with streaming output, markdown rendering, syntax highlighting
- **Multi-provider** — Anthropic (Claude), OpenAI, Google (Gemini), Groq, xAI, OpenRouter, and custom OpenAI-compatible endpoints
- **Built-in tools** — `read`, `write`, `edit`, `bash`, `find`, `grep`, `ls`, `web_search`, `web_fetch`, `browser_fetch`
- **Safety and yolo execution modes** — default safety posture restricts built-in `write` and `edit` to the active workspace; yolo removes that guard
- **Session persistence** — SQLite-backed sessions with branching, forking, and tree navigation
- **Extensions** — JS/TS plugin system for custom tools, commands, and hooks
- **Skills** — markdown-based instruction files that auto-load contextual knowledge
- **System prompt templates** — save and switch between named prompt configurations
- **OAuth login** — browser/device login for Anthropic, OpenAI, and GitHub Copilot

## System Prompt Templates

Save prompt templates in `~/.kordi/system-prompts/` and switch between them.

```bash
kordi --list-templates                   # List available templates
kordi -t coding                          # Start with "coding" template
kordi -t research                        # Start with "research" template
kordi --system-prompt @path/to/file.md   # Load prompt from any file
```

## Extensions & Skills

```bash
kordi install npm:some-skill             # Install a global package
kordi install --local ./my-skill         # Install project-local
kordi list                               # List installed packages
kordi update                             # Update packages
```

## Configuration

Kordi uses layered configuration:

| File | Scope |
|------|-------|
| `~/.kordi/settings.json` | Global settings |
| `<project>/.kordi/settings.json` | Project settings (overrides global) |
| `~/.kordi/AGENTS.md` or `AGENTS.md` | System prompt additions |
| `~/.kordi/system-prompts/<name>.md` | Named prompt templates |
| `~/.kordi/skills/` | Global skills |
| `~/.kordi/extensions/` | Global extensions |

Legacy agent paths are still discovered and are migrated to `~/.kordi/...` / `.kordi/...` when the new target does not already exist.

### Example `settings.json`

```json
{
  "execution_mode": "safety",
  "default_model": "claude-sonnet-4-20250514",
  "default_provider": "anthropic",
  "default_thinking": "medium",
  "execution_mode": "safety",
  "models": [
    {
      "id": "my-local-model",
      "provider": "ollama",
      "api": "openai",
      "base_url": "http://localhost:11434/v1",
      "context_window": 32000,
      "max_tokens": 4096
    }
  ]
}
```

### Execution Modes

Kordi exposes the active permission posture in the TUI and `/session`.

- `safety` is the default. Built-in `write` and `edit` stay inside the current workspace, and bash commands use the safer approval/sandboxed posture.
- `yolo` is the opt-in less-restrictive mode.

Example:

```json
{
  "execution_mode": "yolo"
}
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit prompt |
| `Shift+Enter` | Insert newline |
| `Esc` | Clear input / cancel / exit prompt |
| `Ctrl+C` | Exit |
| `Ctrl+P` | Cycle models |
| `Ctrl+O` | Open settings menu |
| `Ctrl+Shift+O` | Expand/collapse tool calls |
| `/` | Slash commands menu |
| `@` | File mention autocomplete |

## Workspace Crates

| Crate | Description |
|-------|-------------|
| `kordi-core` | Core agent, session, config, and runtime types |
| `kordi-session` | SQLite-backed session storage, branching, context building |
| `kordi-tools` | Built-in tool implementations |
| `kordi-provider` | Model/provider integrations and streaming |
| `kordi-hooks` | Hook event types for extensions |
| `kordi-plugin-host` | Plugin discovery and host runtime |
| `kordi-tui` | Terminal UI components and the interactive TUI experience |
| `kordi-cli` | The `kordi` command-line application used in this monorepo |

## Troubleshooting

### Terminal & Font Compatibility

Kordi uses Unicode glyphs and ANSI color in the TUI. For the best visual experience, use a modern terminal and a Unicode-capable monospace font such as:

- JetBrains Mono
- SF Mono / Menlo
- Fira Code
- Cascadia Mono
- Nerd Font variants of the above

If some symbols look broken, missing, or too narrow in your terminal:

1. switch to a Unicode-capable monospace font
2. make sure your terminal uses UTF-8
3. enable Kordi compatibility mode

Compatibility mode uses safer ASCII-style fallback glyphs for spinner/status/tool markers:

```bash
KORDI_TUI_COMPAT=1 kordi
```

Or set this in `~/.kordi/settings.json`:

```json
{
  "compatibility_mode": true
}
```

## Documentation

- [Configuration Reference](docs/configuration.md) — settings.json, AGENTS.md, templates
- [Built-in Tools](docs/tools.md) — all 10 tools with parameters
- [Extensions & Skills](docs/extensions.md) — plugins, skills, prompts, packages
- [Providers & Models](docs/providers.md) — authentication, model selection, custom providers
- [Development Guide](docs/development.md) — build from source, dev workflow, project structure, debugging
- [Contributing](CONTRIBUTING.md) — code style, PR process
- [Changelog](CHANGELOG.md) — release history

## Development

See the full [Development Guide](docs/development.md) for detailed instructions.

```bash
git clone https://github.com/Kordi-AI/Kordi.git kordi
cd kordi
cargo install --path agent/crates/cli   # Build + install the runtime binary
kordi                                   # Run it
```

Dev cycle:
```bash
cargo run --bin kordi                   # Run without installing
cargo test --workspace --release     # Run all 435 tests
cargo fmt --all                      # Format
cargo clippy --workspace             # Lint
```

## License

[MIT License](LICENSE)
