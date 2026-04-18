# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added a new `registry/` TypeScript package for running a standalone Bridges registry service with Hono and SQLite.
- Added token-based authentication endpoints for node registration and token refresh.
- Added protected node, project, invite, and skill management routes for the registry API.
- Added SQLite schema and query helpers for nodes, projects, project members, invites, and agent skills.
- Added a simple CLI entrypoint for starting the registry server with configurable `--port` and `--db` flags.
- Added shared registry validation helpers for node, project, invite, and skill payloads.
- Added registry auth and authorization tests covering token rotation, input validation, node visibility, invite usage, and permission enforcement.

### Changed
- Restricted node discovery so authenticated nodes only see themselves and nodes that share an active project.
- Tightened invite revocation to project owners only.
- Tightened skill deletion to the skill owner or project owner.
- Made invite joins transactional and bound joined membership to the authenticated caller.
- Added indexes for common registry token and foreign-key lookups.

### Verified
- Built the registry package successfully with `npm run build`.
- Smoke-tested the registry server startup and `/health` endpoint locally.
- Ran `cd registry && npm run build && npm test` successfully.
- Simulated CI registry install/test flow with `npm ci --ignore-scripts`, `npm rebuild better-sqlite3`, and `npm test` successfully.
- Ran `cargo clippy --manifest-path cli/Cargo.toml -- -D warnings` and `cargo test --manifest-path cli/Cargo.toml` successfully.
