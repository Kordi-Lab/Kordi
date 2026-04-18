#!/usr/bin/env bash
# Bridges: Run a daily standup across all project agents
#
# Usage:
#   chmod +x daily-standup.sh
#   ./daily-standup.sh [project-id]

set -euo pipefail

PROJECT="${1:-}"

echo "=== Bridges Daily Standup ==="
echo ""

# Step 1: Optionally sync latest shared state
echo "Syncing shared workspace notes (optional)..."
bridges sync ${PROJECT:+--project "$PROJECT"} || true

# Step 2: Show everyone's progress
echo ""
echo "--- Current Progress ---"
echo "Read .shared/PROGRESS.md and .shared/CHANGELOG.md in the project checkout if your team uses shared workspace sync."

# Step 3: Broadcast standup question
echo ""
echo "--- Asking all agents for standup update ---"
bridges broadcast "Standup: What did you work on? What are you working on next? Any blockers?" ${PROJECT:+--project "$PROJECT"}

echo ""
echo "=== Standup Complete ==="
