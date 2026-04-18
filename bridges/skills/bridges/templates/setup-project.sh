#!/usr/bin/env bash
# Bridges: Create a project and generate an invite
#
# Usage:
#   chmod +x setup-project.sh
#   ./setup-project.sh <project-name> [description]

set -euo pipefail

PROJECT_NAME="${1:?Usage: ./setup-project.sh <project-name> [description]}"
DESCRIPTION="${2:-}"

echo "=== Bridges Project Setup ==="
echo ""

# Step 1: Show current setup
bridges status

# Step 2: Create project
echo ""
echo "Creating project..."
if [ -n "$DESCRIPTION" ]; then
  bridges create "$PROJECT_NAME" --description "$DESCRIPTION"
else
  bridges create "$PROJECT_NAME"
fi

read -r -p "Project created. Enter the proj_... ID from the output: " PROJECT_ID

# Step 3: Generate invite
echo ""
echo "Generating shareable invite..."
bridges invite --project "$PROJECT_ID"

echo ""
echo "=== Done ==="
echo "Share the printed bridges://join/... invite string with collaborators."
echo "They join by running: bridges join <shareable_invite>"
