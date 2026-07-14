# OpenAI Self-Agent Runtime Model Selection Design

## Goal

Make model changes from a self-agent chat update the actual Rust runtime session, and make `gpt-5.6-sol` the implicit OpenAI default for new or otherwise unspecified agent runtimes.

## Scope

- Self-agent chats backed by canonical Cloud session IDs must be able to change their exact local runtime model.
- The Rust runtime's implicit OpenAI default becomes `gpt-5.6-sol`.
- The Agent page derives an unspecified agent's default route from that runtime default.
- Agents with an explicitly saved model keep that model. There is no bulk migration or overwrite.
- Cloud direct-person chats and group chats remain protected from local runtime session-config updates.

## Root Cause

The model catalog is correct, but the self-agent selection path is not connected to the runtime:

1. The composer treats every canonical Cloud session as an invalid config target, including canonical self-agent sessions.
2. The menu therefore updates only React selection state.
3. Periodic desktop-state synchronization restores the model from the unchanged Rust runtime, making the new selection appear unselectable.
4. The existing Rust update command uses a fallback loader that may select another loaded session when the requested session does not yet have a local runtime.
5. OpenAI implicit defaults still resolve to GPT-5.5 or GPT-5.4 in several root startup paths.

## Design

### Exact runtime targeting

The normal, non-Bridge self-agent composer will pass its canonical session ID as the explicit config target. Direct-person and group composers will continue to avoid this local-runtime command.

`desktop_chat_update_session_config` will honor the requested ID by loading or creating that exact runtime session. It will not silently fall back to the first persisted or transient session. The command will set the selected model and compatible thinking level on `DesktopRuntimeSession`, persist the change through the existing session machinery, rebuild desktop chat state, and return that authoritative state to React.

React will continue its optimistic update for responsiveness, but the backend response is authoritative. On a runtime error, React refreshes the session and shows the existing error message rather than pretending the model changed.

### Root OpenAI default

The preferred OpenAI model in the Rust authentication/startup resolver becomes `gpt-5.6-sol`. The core model-argument fallback for OpenAI and the desktop Cloud auth snapshot fallback will use the same model so new runtimes and newly seeded agent routes agree.

The catalog remains newest-first; catalog order does not determine the default. GPT-5.6 Luna and Terra stay selectable but are not implicit defaults.

### Agent page behavior

The Agent page will continue to prefer an agent's explicit saved route. When no explicit route exists, it will receive and display the local agent runtime route, whose root default is now `openai/gpt-5.6-sol`.

Saving a different route remains explicit and persists normally. Existing GPT-5.4, GPT-5.5, Luna, Terra, Anthropic, Google, local-model, or other saved routes are not rewritten.

### Thinking levels

Changing to GPT-5.6 Sol uses the existing auth-aware capability matrix. If the previous thinking level is unsupported, the runtime applies the existing compatible fallback. No new thinking-level policy is introduced here.

## Testing

- A frontend routing test proves canonical self-agent sessions receive an explicit runtime config target while Cloud person/group sessions do not.
- A Rust desktop-runtime test proves session config updates target the requested session rather than a fallback session.
- Resolver tests prove authenticated OpenAI startup selects `gpt-5.6-sol` while explicit saved defaults still win.
- Core parsing and desktop auth snapshot tests keep the implicit OpenAI fallback consistent.
- Agent routing tests prove an absent route inherits the runtime default and an explicit route remains unchanged.
- The full focused Rust and desktop test suites run before restarting the isolated `user2` app.

## Runtime Verification

The `user2` feature instance will be restarted with the local proxy at `127.0.0.1:7890`. Verification will select GPT-5.6 Sol in a canonical self-agent session, confirm the menu remains on Sol after state refresh, and confirm the returned runtime session state reports `openai/gpt-5.6-sol`.
