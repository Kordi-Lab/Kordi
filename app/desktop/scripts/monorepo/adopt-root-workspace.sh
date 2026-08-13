#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"

AGENT_WORKSPACE="$ROOT_DIR/agent/Cargo.toml"
AGENT_WORKSPACE_TEMPLATE="$ROOT_DIR/agent/Cargo.workspace-template.toml"
ROOT_CARGO="$ROOT_DIR/Cargo.toml"
ROOT_PACKAGE="$ROOT_DIR/package.json"
ROOT_PNPM="$ROOT_DIR/pnpm-workspace.yaml"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../../templates/monorepo" && pwd)"

if [[ ! -f "$AGENT_WORKSPACE" ]]; then
  echo "Missing agent workspace manifest: $AGENT_WORKSPACE" >&2
  exit 1
fi

cp "$TEMPLATE_DIR/package.json" "$ROOT_PACKAGE"
cp "$TEMPLATE_DIR/pnpm-workspace.yaml" "$ROOT_PNPM"
cp "$TEMPLATE_DIR/.gitignore" "$ROOT_DIR/.gitignore"

if [[ ! -f "$AGENT_WORKSPACE_TEMPLATE" ]]; then
  cp "$AGENT_WORKSPACE" "$AGENT_WORKSPACE_TEMPLATE"
fi

perl -0pe 's#"crates/#"agent/crates/#g' "$AGENT_WORKSPACE_TEMPLATE" > "$ROOT_CARGO"

perl -0pi -e '
  s/members = \[\n(.*?)\n\]/members = [\n$1\n    "app\/desktop\/src-tauri",\n    "bridges\/cli",\n    "shared\/rust\/protocol",\n]/s;
' "$ROOT_CARGO"

mv "$AGENT_WORKSPACE" "$ROOT_DIR/agent/Cargo.toml.legacy"

mkdir -p "$ROOT_DIR/shared/rust/protocol/src"

cat > "$ROOT_DIR/shared/rust/protocol/Cargo.toml" <<'EOF'
[package]
name = "kordi-protocol"
version = "0.1.0"
edition = "2024"
license = "MIT"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
EOF

cat > "$ROOT_DIR/shared/rust/protocol/src/lib.rs" <<'EOF'
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthSnapshot {
    pub status: String,
}
EOF

cat <<EOF
Root workspaces written at:
  $ROOT_DIR/Cargo.toml
  $ROOT_DIR/package.json
  $ROOT_DIR/pnpm-workspace.yaml

Migration inputs:
  $AGENT_WORKSPACE_TEMPLATE
  $ROOT_DIR/agent/Cargo.toml.legacy

Suggested next commands:
  cd "$ROOT_DIR"
  cargo check --workspace
  pnpm install
EOF
