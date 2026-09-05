# Providers & Models

Kordi supports multiple LLM providers out of the box.

## Role in Kordi

Use this document when you need the provider and model surface for the Kordi agent layer.

It is the reference for:

- supported providers
- authentication flows
- model selection
- thinking-level selection

## Supported Providers

| Provider | Auth Method | Models |
|----------|-------------|--------|
| **Anthropic** | OAuth or `ANTHROPIC_API_KEY` | Claude Fable 5.1, Fable 5, Opus, Sonnet, Haiku |
| **OpenAI** | OAuth or `OPENAI_API_KEY` | GPT-6 Astra, GPT-5.6 variants, and earlier API models |
| **LM Studio** | No key for local server; optional `LM_STUDIO_API_KEY` | Models loaded in the LM Studio app (`http://localhost:1234/v1`) |
| **Ollama** | No key for local server; optional `OLLAMA_API_KEY` | Installed Ollama models (`http://localhost:11434/v1`) |
| **GitHub Copilot** | OAuth/device flow or `GH_COPILOT_TOKEN` | Copilot chat models |
| **Google** | `GOOGLE_API_KEY` | Gemini 2.5 Pro, Flash |
| **Groq** | `GROQ_API_KEY` | Llama, Mixtral |
| **xAI** | `XAI_API_KEY` | Grok |
| **OpenRouter** | `OPENROUTER_API_KEY` | 100+ models |
| **Custom** | Configurable | Any OpenAI-compatible API |

## Authentication

### OAuth Login (Anthropic, OpenAI, GitHub Copilot)

```bash
kordi login anthropic        # Opens browser for OAuth
kordi login openai-codex     # Opens browser for OAuth
kordi login github-copilot   # GitHub device flow + Copilot token exchange
```

For GitHub Copilot, `kordi` now supports:
- stored authority-aware configuration (`github.com` or GitHub Enterprise Server domain)
- GitHub device/browser auth flow
- GitHub OAuth token persistence in `auth.json`
- Copilot runtime token exchange via GitHub's Copilot token endpoint
- Copilot runtime token refresh by re-exchanging the saved GitHub OAuth session when `GITHUB_COPILOT_CLIENT_SECRET` (or `GH_COPILOT_CLIENT_SECRET`) is provided
- `/models` validation and cached Copilot model discovery
- Copilot auth/session visibility in `/session`

Current limitations:
- Copilot request behavior is wired through the OpenAI-compatible runtime path and may still need endpoint/header adjustments for some models or enterprise installations
- Enterprise endpoint behavior still needs more real-world validation

### API Key Login

```bash
kordi login google         # Prompts for API key
kordi login groq
kordi login xai
kordi login openrouter
```

### Local OpenAI-compatible servers

LM Studio and Ollama are available without a saved API key when their local OpenAI-compatible servers are running:

```bash
# LM Studio: start the local server in the macOS app, then select one of its live models.
kordi --provider lm-studio --model qwen3-coder-30b

# Ollama: install/start Ollama and use its OpenAI-compatible endpoint.
kordi --provider ollama --model llama3.2
```

Kordi discovers live model ids from `/v1/models` for these local providers and does not send an `Authorization` header unless an optional key is configured. In the desktop app, open **Settings → Authentication → LM Studio/Ollama** to adjust the local port if your server is not using the default `1234` or `11434` port.

### Environment Variables

Set directly without `kordi login`:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="..."
export GROQ_API_KEY="..."
export XAI_API_KEY="..."
export OPENROUTER_API_KEY="..."
export LM_STUDIO_API_KEY="..."                # Optional: only if your local server requires it
export OLLAMA_API_KEY="..."                   # Optional: only if your local server requires it
export GH_COPILOT_TOKEN="..."                 # Direct Copilot runtime token
export GITHUB_COPILOT_TOKEN="..."             # Equivalent env fallback
export GITHUB_COPILOT_CLIENT_SECRET="..."     # Optional: only needed for GitHub OAuth refresh support
```

If you do not set `GITHUB_COPILOT_CLIENT_SECRET`, GitHub Copilot sign-in still works, but expired GitHub OAuth sessions must be refreshed by logging in again.

### Check Status

```bash
kordi login    # Shows ✓/✗ for each provider
```

## Selecting a Model

### September 2026 models

Select `openai/gpt-6-astra` or `anthropic/claude-fable-5-1` in the desktop or iPhone model picker. Existing defaults are unchanged; provider account access still applies. These IDs are included in the built-in fallback catalogs when live discovery is unavailable.

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) uses Responses for OpenAI API tool calls. Its effort levels are `low`, `medium`, `high`, `xhigh`, and `max`; saved `off` or `minimal` settings become `low`.
- [Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide) uses always-on adaptive thinking. The legacy `minimal` setting maps to `low`; a saved `off` setting omits the thinking override rather than disabling thinking. Kordi leaves tool choice automatic. Its runtime transcript contains text and tool calls/results, without replaying signed thinking blocks that may be bound to an earlier conversation prefix.

Registry costs use standard short-context rates. GPT-6 Astra's [long-context and service-tier pricing](https://developers.openai.com/api/docs/pricing) is not represented by the flat registry cost fields.

### CLI Flags

```bash
kordi --model sonnet                                # Fuzzy match
kordi --model claude-sonnet-4-20250514              # Exact model ID
kordi --model anthropic/claude-sonnet-4-20250514    # Provider/model
kordi --model sonnet:high                           # Model with thinking level
kordi --provider google --model gemini-2.5-flash    # Explicit provider
```

### Thinking Levels

For models that support extended thinking:

```bash
kordi --model sonnet:high      # High thinking budget
kordi --model sonnet:medium    # Medium (default)
kordi --model sonnet:low       # Low
kordi --model sonnet:off       # No extended thinking
kordi --thinking high          # Set thinking separately
```

### List Available Models

```bash
kordi --list-models            # List all models
kordi --list-models sonnet     # Search/filter
kordi --list-models groq       # Models from a provider
```

### In-Session Model Switching

Press `Ctrl+P` to cycle through models, or use:
```
/model sonnet
/model gpt-4o
/model openai/gpt-4o
/model openai:gpt-4o
/model sonnet:high
/model anthropic/claude-sonnet-4-20250514:low
```

`/model` now accepts common provider/model and thinking-suffix formats directly during a conversation.

### Default Model

In `settings.json`:
```json
{
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-20250514",
  "default_thinking": "medium"
}
```

## Custom Models

Add models that aren't in the built-in registry:

```json
{
  "models": [
    {
      "id": "llama3-70b",
      "name": "Llama 3 70B (local)",
      "provider": "ollama",
      "api": "openai",
      "base_url": "http://localhost:11434/v1",
      "context_window": 8192,
      "max_tokens": 4096,
      "reasoning": false
    }
  ]
}
```

## Custom Providers

Define entirely new providers:

```json
{
  "providers": [
    {
      "name": "my-corp",
      "base_url": "https://llm.internal.corp.com/v1",
      "api_key_env": "CORP_LLM_KEY",
      "api": "openai",
      "headers": {
        "X-Team": "engineering"
      }
    }
  ]
}
```

Then use:
```bash
kordi --provider my-corp --model our-model
```

For local/self-hosted OpenAI-compatible servers, `base_url` can point at a loopback endpoint and the API key may be omitted:

```json
{
  "providers": [
    {
      "name": "vllm-local",
      "base_url": "http://localhost:8000/v1",
      "api": "openai"
    }
  ]
}
```

## API Types

The `api` field determines the request/response format:

| Value | Compatible With |
|-------|----------------|
| `openai` | OpenAI, Groq, xAI, OpenRouter, Ollama, vLLM, LiteLLM |
| `anthropic` | Anthropic |
| `google` | Google Gemini |

## Related docs

- [README.md](README.md)
- [development.md](development.md)
- [configuration.md](configuration.md)
