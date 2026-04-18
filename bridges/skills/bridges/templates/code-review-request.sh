#!/usr/bin/env bash
# Bridges: Request a code review from another agent
#
# Usage:
#   chmod +x code-review-request.sh
#   ./code-review-request.sh <project-id> <node-id> <file>

set -euo pipefail

PROJECT_ID="${1:?Usage: code-review-request.sh <project-id> <node-id> <file>}"
TARGET="${2:?Usage: code-review-request.sh <project-id> <node-id> <file>}"
FILE="${3:?Usage: code-review-request.sh <project-id> <node-id> <file>}"

echo "=== Bridges Code Review Request ==="
echo ""

# Step 1: Publish the file as artifact
echo "Publishing $FILE as artifact..."
bridges publish "$FILE" --project "$PROJECT_ID"

# Step 2: Ask for review
echo "Requesting review from $TARGET..."
bridges ask "$TARGET" \
  "Please review the file I just published: $FILE. Focus on correctness, edge cases, and style." \
  --project "$PROJECT_ID"

echo ""
echo "=== Review Requested ==="
