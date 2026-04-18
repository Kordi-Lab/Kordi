#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_NAME="$(sed -n 's/^name = "\([^"]*\)"$/\1/p' "$ROOT_DIR/cli/Cargo.toml" | head -n1)"
CLI_NAME="${CLI_NAME:-bridges}"
BIN_PATH="${BRIDGES_BIN:-$ROOT_DIR/target/release/$CLI_NAME}"
BASE_DIR="${BRIDGES_TEST_DIR:-/tmp/${CLI_NAME}-two-agent-smoke}"
SESSION_NAME="${BRIDGES_TMUX_SESSION:-${CLI_NAME}-two-agent-smoke}"
COORD_PORT="${BRIDGES_TEST_COORD_PORT:-17080}"
ALICE_DAEMON_PORT="${BRIDGES_TEST_ALICE_DAEMON_PORT:-17071}"
BOB_DAEMON_PORT="${BRIDGES_TEST_BOB_DAEMON_PORT:-17072}"
ALICE_RUNTIME_PORT="${BRIDGES_TEST_ALICE_RUNTIME_PORT:-18081}"
BOB_RUNTIME_PORT="${BRIDGES_TEST_BOB_RUNTIME_PORT:-18082}"
COORD_URL="${BRIDGES_COORDINATION_URL:-}"
RUNTIME_MODE="${BRIDGES_RUNTIME_MODE:-mock}"
DERP_ENABLED="${BRIDGES_DERP_ENABLED:-true}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dir PATH] [--session NAME] [--coordination URL] [--runtime-mode mock|claude]

Starts a fresh tmux-based two-agent smoke test for ${CLI_NAME}.
By default it boots a local coordination server plus two isolated clients.

Environment overrides:
  BRIDGES_BIN
  BRIDGES_TEST_DIR
  BRIDGES_TMUX_SESSION
  BRIDGES_TEST_COORD_PORT
  BRIDGES_TEST_ALICE_DAEMON_PORT
  BRIDGES_TEST_BOB_DAEMON_PORT
  BRIDGES_TEST_ALICE_RUNTIME_PORT
  BRIDGES_TEST_BOB_RUNTIME_PORT
  BRIDGES_COORDINATION_URL
  BRIDGES_RUNTIME_MODE
  BRIDGES_DERP_ENABLED
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      BASE_DIR="$2"
      shift 2
      ;;
    --session)
      SESSION_NAME="$2"
      shift 2
      ;;
    --coordination)
      COORD_URL="$2"
      shift 2
      ;;
    --runtime-mode)
      RUNTIME_MODE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$RUNTIME_MODE" != "mock" && "$RUNTIME_MODE" != "claude" ]]; then
  echo "runtime mode must be 'mock' or 'claude'" >&2
  exit 1
fi

if [[ ! -x "$BIN_PATH" ]]; then
  echo "missing binary at $BIN_PATH; run npm run build first" >&2
  exit 1
fi

if [[ -z "$COORD_URL" ]]; then
  COORD_URL="http://127.0.0.1:${COORD_PORT}"
  USE_LOCAL_SERVER=1
else
  USE_LOCAL_SERVER=0
fi

SERVER_HOME="$BASE_DIR/server-home"
ALICE_HOME="$BASE_DIR/alice-home"
BOB_HOME="$BASE_DIR/bob-home"
SERVER_DB="$BASE_DIR/bridges-server.db"
SUMMARY_PATH="$BASE_DIR/summary.env"
PROJECT_SLUG="smoke-project-$(date +%s)"

wait_for_http() {
  local url="$1"
  local attempts="${2:-50}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

run_client() {
  local home_dir="$1"
  local user_name="$2"
  local daemon_port="$3"
  shift 3
  HOME="$home_dir" USER="$user_name" BRIDGES_DAEMON_PORT="$daemon_port" "$BIN_PATH" "$@"
}

configure_git_identity() {
  local home_dir="$1"
  local user_name="$2"
  HOME="$home_dir" git config --global user.name "$user_name"
  HOME="$home_dir" git config --global user.email "${user_name}@bridges.test"
}

copy_claude_auth() {
  local home_dir="$1"
  mkdir -p "$home_dir/.claude"
  cp "$HOME/.claude/.credentials.json" "$home_dir/.claude/"
  if [[ -f "$HOME/.claude/settings.json" ]]; then
    cp "$HOME/.claude/settings.json" "$home_dir/.claude/"
  fi
}

configure_daemon() {
  local home_dir="$1"
  local port="$2"
  local runtime="$3"
  local endpoint="$4"
  local project_dir="$5"
  local tmp_js="$BASE_DIR/update-daemon-config.js"
  cat >"$tmp_js" <<'EOF'
const fs = require("node:fs");
const path = process.argv[2];
const port = Number(process.argv[3]);
const runtime = process.argv[4];
const endpoint = process.argv[5];
const projectDir = process.argv[6];
const derpEnabled = process.argv[7] === "true";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.local_api_port = port;
config.runtime = runtime;
config.runtime_endpoint = endpoint;
config.project_dir = projectDir;
config.stun_servers = [];
config.derp_enabled = derpEnabled;
fs.writeFileSync(path, JSON.stringify(config, null, 2));
EOF
  node "$tmp_js" "$home_dir/.bridges/daemon.json" "$port" "$runtime" "$endpoint" "$project_dir" "$DERP_ENABLED"
}

pane_cmd() {
  local workdir="$1"
  local command="$2"
  printf 'cd %q && %s' "$workdir" "$command"
}

rm -rf "$BASE_DIR"
mkdir -p "$SERVER_HOME" "$ALICE_HOME" "$BOB_HOME"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -n daemon-alice
tmux new-window -t "$SESSION_NAME" -n daemon-bob
if [[ "$RUNTIME_MODE" == "mock" ]]; then
  tmux new-window -t "$SESSION_NAME" -n runtime-alice
  tmux new-window -t "$SESSION_NAME" -n runtime-bob
fi
if [[ "$USE_LOCAL_SERVER" -eq 1 ]]; then
  tmux new-window -t "$SESSION_NAME" -n server
fi

if [[ "$RUNTIME_MODE" == "mock" ]]; then
  tmux send-keys -t "$SESSION_NAME:runtime-alice" "$(pane_cmd "$ROOT_DIR" "node scripts/mock-chat-runtime.js --port $ALICE_RUNTIME_PORT --name alice-runtime")" C-m
  tmux send-keys -t "$SESSION_NAME:runtime-bob" "$(pane_cmd "$ROOT_DIR" "node scripts/mock-chat-runtime.js --port $BOB_RUNTIME_PORT --name bob-runtime")" C-m
  wait_for_http "http://127.0.0.1:${ALICE_RUNTIME_PORT}/health"
  wait_for_http "http://127.0.0.1:${BOB_RUNTIME_PORT}/health"
fi

if [[ "$USE_LOCAL_SERVER" -eq 1 ]]; then
  tmux send-keys -t "$SESSION_NAME:server" "$(pane_cmd "$ROOT_DIR" "HOME=$SERVER_HOME \"$BIN_PATH\" serve --port $COORD_PORT --db $SERVER_DB")" C-m
  wait_for_http "$COORD_URL/health" 150
fi

if [[ "$RUNTIME_MODE" == "claude" ]]; then
  copy_claude_auth "$ALICE_HOME"
  copy_claude_auth "$BOB_HOME"
  ALICE_SETUP_OUTPUT="$(run_client "$ALICE_HOME" alice "$ALICE_DAEMON_PORT" setup --coordination "$COORD_URL" --runtime claude-code --name alice 2>&1)"
  BOB_SETUP_OUTPUT="$(run_client "$BOB_HOME" bob "$BOB_DAEMON_PORT" setup --coordination "$COORD_URL" --runtime claude-code --name bob 2>&1)"
else
  ALICE_SETUP_OUTPUT="$(run_client "$ALICE_HOME" alice "$ALICE_DAEMON_PORT" setup --coordination "$COORD_URL" --runtime generic --endpoint "http://127.0.0.1:${ALICE_RUNTIME_PORT}" --name alice 2>&1)"
  BOB_SETUP_OUTPUT="$(run_client "$BOB_HOME" bob "$BOB_DAEMON_PORT" setup --coordination "$COORD_URL" --runtime generic --endpoint "http://127.0.0.1:${BOB_RUNTIME_PORT}" --name bob 2>&1)"
fi

ALICE_NODE_ID="$(printf '%s\n' "$ALICE_SETUP_OUTPUT" | sed -n 's/^Node ID: //p' | tail -n1)"
BOB_NODE_ID="$(printf '%s\n' "$BOB_SETUP_OUTPUT" | sed -n 's/^Node ID: //p' | tail -n1)"

configure_git_identity "$ALICE_HOME" alice
configure_git_identity "$BOB_HOME" bob

CREATE_OUTPUT="$(run_client "$ALICE_HOME" alice "$ALICE_DAEMON_PORT" create "$PROJECT_SLUG" 2>&1)"
PROJECT_ID="$(printf '%s\n' "$CREATE_OUTPUT" | sed -n 's/^Project created: //p' | tail -n1)"
ALICE_PROJECT_DIR="$ALICE_HOME/bridges-projects/$PROJECT_SLUG"

cat >"$ALICE_PROJECT_DIR/.shared/PROJECT.md" <<EOF
# Project

This is a Bridges end-to-end collaboration test.

- Alice created the project.
- Bob joins through an invite.
- Bob should ask Alice's agent what the project is about and what to do first.
- A good answer should mention validating Bridges collaboration and coordination flow.
EOF

INVITE_OUTPUT="$(run_client "$ALICE_HOME" alice "$ALICE_DAEMON_PORT" invite --project "$PROJECT_ID" 2>&1)"
INVITE_TOKEN="$(printf '%s\n' "$INVITE_OUTPUT" | sed -n 's/^Invite token: //p' | tail -n1)"

JOIN_OUTPUT="$(run_client "$BOB_HOME" bob "$BOB_DAEMON_PORT" join --project "$PROJECT_ID" "$INVITE_TOKEN" 2>&1)"
BOB_PROJECT_DIR="$BOB_HOME/bridges-projects/$PROJECT_SLUG"

if [[ "$RUNTIME_MODE" == "claude" ]]; then
  configure_daemon "$ALICE_HOME" "$ALICE_DAEMON_PORT" "claude-code" "" "$ALICE_PROJECT_DIR"
  configure_daemon "$BOB_HOME" "$BOB_DAEMON_PORT" "claude-code" "" "$BOB_PROJECT_DIR"
else
  configure_daemon "$ALICE_HOME" "$ALICE_DAEMON_PORT" "generic" "http://127.0.0.1:${ALICE_RUNTIME_PORT}" "$ALICE_PROJECT_DIR"
  configure_daemon "$BOB_HOME" "$BOB_DAEMON_PORT" "generic" "http://127.0.0.1:${BOB_RUNTIME_PORT}" "$BOB_PROJECT_DIR"
fi

tmux send-keys -t "$SESSION_NAME:daemon-alice" "$(pane_cmd "$ROOT_DIR" "HOME=$ALICE_HOME USER=alice \"$BIN_PATH\" daemon")" C-m
tmux send-keys -t "$SESSION_NAME:daemon-bob" "$(pane_cmd "$ROOT_DIR" "HOME=$BOB_HOME USER=bob \"$BIN_PATH\" daemon")" C-m

wait_for_http "http://127.0.0.1:${ALICE_DAEMON_PORT}/status" 100
wait_for_http "http://127.0.0.1:${BOB_DAEMON_PORT}/status" 100

MEMBERS_OUTPUT="$(run_client "$ALICE_HOME" alice "$ALICE_DAEMON_PORT" members --project "$PROJECT_ID" 2>&1)"
ASK_OUTPUT="$(run_client "$BOB_HOME" bob "$BOB_DAEMON_PORT" ask "$ALICE_NODE_ID" "What is this project about and what should I do first?" --project "$PROJECT_ID" 2>&1)"
DEBATE_OUTPUT="$(run_client "$BOB_HOME" bob "$BOB_DAEMON_PORT" debate "Should Bridges prioritize verifying ask flow or debate flow first in this smoke test?" --project "$PROJECT_ID" 2>&1)"

cat >"$SUMMARY_PATH" <<EOF
SESSION_NAME=$SESSION_NAME
BASE_DIR=$BASE_DIR
COORD_URL=$COORD_URL
RUNTIME_MODE=$RUNTIME_MODE
PROJECT_ID=$PROJECT_ID
PROJECT_SLUG=$PROJECT_SLUG
INVITE_TOKEN=$INVITE_TOKEN
ALICE_NODE_ID=$ALICE_NODE_ID
BOB_NODE_ID=$BOB_NODE_ID
EOF

echo "Bridges smoke test completed."
echo "tmux session: $SESSION_NAME"
echo "base dir: $BASE_DIR"
echo "coordination: $COORD_URL"
echo "project: $PROJECT_ID"
echo "alice: $ALICE_NODE_ID"
echo "bob: $BOB_NODE_ID"
echo
echo "Members output:"
printf '%s\n' "$MEMBERS_OUTPUT"
echo
echo "Ask output:"
printf '%s\n' "$ASK_OUTPUT"
echo
echo "Debate output:"
printf '%s\n' "$DEBATE_OUTPUT"
echo
echo "Summary saved to $SUMMARY_PATH"
echo "Attach with: tmux attach -t $SESSION_NAME"
echo "Setup outputs are in the script logs if needed."
