# OpenAI Codex Model Capabilities Design

## Goal

Keep Kordi's OpenAI model catalog, thinking controls, and serialized reasoning effort aligned. The model selector must advertise only current Codex OAuth models, direct OpenAI must include the three GPT-5.6 variants, and every layer must understand the new `max` thinking level.

## Catalog contract

Codex OAuth advertises, in order:

1. `gpt-5.3-codex-spark`
2. `gpt-5.4`
3. `gpt-5.4-mini`
4. `gpt-5.5`
5. `gpt-5.6-luna`
6. `gpt-5.6-sol`
7. `gpt-5.6-terra`

The direct OpenAI registry adds the three GPT-5.6 variants. It does not add a bare `gpt-5.6` alias. The default model remains `gpt-5.5`, and a saved OAuth model removed from the catalog falls back through the existing preferred-model path.

## Capability source of truth

The OpenAI provider owns a small capability module keyed by exact model ID and route (`Api` or `CodexOAuth`). It supplies:

- supported thinking levels;
- nearest supported fallback for a requested level;
- wire-level reasoning effort.

The desktop runtime consumes this module for OpenAI models instead of maintaining a second family-name heuristic. Other providers retain their existing behavior.

Supported levels are:

- GPT-5.6 variants, API and OAuth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`;
- GPT-5.5 OAuth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`;
- GPT-5.5 API: `off`, `low`, `medium`, `high`, `xhigh`;
- GPT-5.4, GPT-5.4 Mini, and GPT-5.3 Codex Spark OAuth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Unsupported high-end selections fall back in descending order (`max` to `xhigh` to `high`) before the ordinary safe fallback is used.

## Serialization

`default` omits reasoning configuration. `off` serializes as `none`. Direct OpenAI preserves `minimal`; Codex OAuth maps `minimal` to `low`. `xhigh` and `max` are preserved when the selected model supports them. The capability layer clamps unsupported selections before serialization so UI choices and payloads cannot drift.

## Cross-layer changes

`max` is added to the core session enum, shared Rust and TypeScript protocol types, server conversion, desktop and TUI labels/options, and frontend fallback logic. Tests cover exact catalog membership, route-specific options, fallback behavior, serialization, parsing, and protocol conversion.

## Compatibility

Existing serialized levels remain unchanged. Unknown or unsupported selections degrade to a supported value rather than causing request failure. No migration is required for stored sessions.
