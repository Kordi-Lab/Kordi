#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  cat <<'EOF'
Usage:
  init-kordi-monorepo.sh <target-dir> <desktop-repo> <agent-repo> <bridges-repo>

Example:
  ./scripts/monorepo/init-kordi-monorepo.sh \
    /Users/shuyang/Desktop/kordi \
    /Users/shuyang/Desktop/Bridges-app \
    /Users/shuyang/Desktop/bb-agent \
    /Users/shuyang/Desktop/Bridges
EOF
  exit 1
fi

TARGET_DIR="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DESKTOP_REPO="$(cd "$2" && pwd)"
AGENT_REPO="$(cd "$3" && pwd)"
BRIDGES_REPO="$(cd "$4" && pwd)"

DESKTOP_BRANCH="${DESKTOP_BRANCH:-$(git -C "$DESKTOP_REPO" branch --show-current)}"
AGENT_BRANCH="${AGENT_BRANCH:-$(git -C "$AGENT_REPO" branch --show-current)}"
BRIDGES_BRANCH="${BRIDGES_BRANCH:-$(git -C "$BRIDGES_REPO" branch --show-current)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(cd "$SCRIPT_DIR/../../templates/monorepo" && pwd)"

if [[ -e "$TARGET_DIR" ]]; then
  echo "Target already exists: $TARGET_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

git init -b main

mkdir -p app bridges agent shared/rust shared/typescript docs scripts
cp "$TEMPLATE_DIR/package.json" package.json
cp "$TEMPLATE_DIR/pnpm-workspace.yaml" pnpm-workspace.yaml
cp "$TEMPLATE_DIR/.gitignore" .gitignore

cat > README.md <<'EOF'
# Kordi

Monorepo for the Kordi desktop app, agent runtime, and Bridges network stack.
EOF

git add .
git commit -m "Initialize Kordi monorepo scaffolding"

git remote add desktop "$DESKTOP_REPO"
git remote add agent "$AGENT_REPO"
git remote add bridges "$BRIDGES_REPO"

git fetch desktop "$DESKTOP_BRANCH"
git fetch agent "$AGENT_BRANCH"
git fetch bridges "$BRIDGES_BRANCH"

git subtree add --prefix app/desktop desktop "$DESKTOP_BRANCH"
git subtree add --prefix agent agent "$AGENT_BRANCH"
git subtree add --prefix bridges bridges "$BRIDGES_BRANCH"

cat <<EOF
Kordi monorepo scaffold created at:
  $TARGET_DIR

Imported histories:
  app/desktop <- $DESKTOP_REPO ($DESKTOP_BRANCH)
  agent       <- $AGENT_REPO ($AGENT_BRANCH)
  bridges     <- $BRIDGES_REPO ($BRIDGES_BRANCH)

Next step:
  run scripts/monorepo/adopt-root-workspace.sh inside the new monorepo root
EOF
