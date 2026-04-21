# Architecture

Kordi is organized into three product layers with one shared integration surface.
The current next step is to introduce a dedicated app-facing server contract so
the desktop frontend and the TUI can share one product backend instead of
directly depending on runtime or network internals.

## Top-level shape

```text
kordi/
  app/desktop
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
  -> app-facing orchestration layer
    -> agent runtime
    -> bridges daemon / registry client
```

That keeps the UI from depending directly on many unrelated backend details.
See [app-server.md](app-server.md) for the concrete server/client/protocol plan.

## Development boundaries

- UI and desktop shell work belong in `app/desktop`
- runtime logic belongs in `agent`
- network logic belongs in `bridges`
- shared contracts belong in `shared`

When deciding where a change should live, prefer the narrowest layer that can own it cleanly.
