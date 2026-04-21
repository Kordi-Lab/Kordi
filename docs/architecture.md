# Architecture

Kordi is organized into three product layers plus one app-facing orchestration layer.
The desktop frontend already uses real runtime and bridge integrations, and the
app-facing server provides the longer-term contract for sharing one product backend
across desktop and future clients.

## Top-level shape

```text
kordi/
  app/desktop
  app/server
  agent
  bridges
  shared
```

## Layer responsibilities

### `app/desktop`

The desktop app is the product surface.

It owns:

- the React user interface
- the Tauri shell
- desktop-specific orchestration
- bundling local sidecars for macOS packaging

It should not directly encode low-level runtime or network internals. The app should stay focused on product flows and desktop UX.

### `app/server`

The app server is the app-facing orchestration layer.

It owns:

- product-facing HTTP endpoints
- composition of runtime state and network state
- client bootstrap and service snapshots
- a stable integration contract for desktop and future shared clients

It should not own provider internals, storage internals, or raw bridge transport semantics.

### `agent`

The agent layer is the local runtime.

It owns:

- agent execution
- provider/model integration
- sessions and persistence
- tools and extensions
- terminal-oriented UX

The desktop app can embed or launch this layer, but the runtime remains the source-of-truth here.

### `bridges`

The Bridges layer is the network stack.

It owns:

- local daemon behavior
- node identity and secure transport
- project membership and coordination
- registry service
- skill assets for external runtimes

The desktop app should consume Bridges as a product dependency, not reimplement network semantics itself.

### `shared`

The shared layer is where cross-cutting contracts should live.

Use it for:

- protocol types shared by Rust crates
- protocol types shared by TypeScript clients
- app-facing integration contracts that cross layer boundaries

## Integration model

The intended direction is:

```text
desktop app
  -> app/server
    -> agent runtime
    -> bridges daemon / registry client
```

That keeps the UI from depending directly on many unrelated backend details.
See [app-server.md](app-server.md) for the concrete server/client/protocol plan.

## Development boundaries

- UI and desktop shell work belong in `app/desktop`
- app-facing orchestration belongs in `app/server`
- runtime logic belongs in `agent`
- network logic belongs in `bridges`
- shared contracts belong in `shared`

When deciding where a change should live, prefer the narrowest layer that can own it cleanly.
