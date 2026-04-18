#!/usr/bin/env bash
# Bridges: Join a project and optionally sync shared workspace state
#
# Usage:
#   chmod +x join-and-sync.sh
#   ./join-and-sync.sh <invite-or-token> [project-id] [project-dir]

set -euo pipefail

INVITE="${1:?Usage: join-and-sync.sh <invite-or-token> [project-id] [project-dir]}"
PROJECT_ID="${2:-}"
PROJECT_DIR="${3:-.}"

echo "=== Bridges: Join Project ==="
echo ""

# Step 1: Join project
echo "Joining project..."
cd "$PROJECT_DIR"
if [[ -n "$PROJECT_ID" ]]; then
  bridges join --project "$PROJECT_ID" "$INVITE"
else
  bridges join "$INVITE"
fi

# Step 2: Optional sync
echo ""
echo "Optionally syncing shared workspace state..."
bridges sync --project "$PROJECT_ID" || true

# Step 3: Show project status
echo ""
echo "=== Project Status ==="
bridges members --project "$PROJECT_ID"
echo ""
echo "Project files live in: ~/bridges-projects/<slug>/"
echo "Read .shared/PROJECT.md, .shared/TODOS.md, and .shared/MEMBERS.md for context if your team uses shared workspace sync."

echo ""
echo "=== Ready ==="
echo "You can now ask peers with: bridges ask <node-id> \"question\" --project \"$PROJECT_ID\""
