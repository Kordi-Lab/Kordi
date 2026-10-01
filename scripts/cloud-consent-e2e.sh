#!/usr/bin/env bash
# End-to-end check of contact consent, blocking, leaving groups, and reports
# against an isolated loopback Cloud API. It signs up fresh synthetic
# accounts and stops at the first mismatch.
#
#   KORDI_API_ORIGIN=http://127.0.0.1:17081 scripts/cloud-consent-e2e.sh
#
# Requires curl, jq, and uuidgen. Never point it at a shared or product
# server: it refuses any origin that is not a loopback address.
set -euo pipefail

origin="${KORDI_API_ORIGIN:-}"
origin="${origin%/}"
if [[ ! "$origin" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$ ]]; then
  echo "KORDI_API_ORIGIN must be a loopback origin such as http://127.0.0.1:17081" >&2
  exit 2
fi
for tool in curl jq uuidgen; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 2; }
done

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
body_file="$work_dir/body.json"
status=""
step=0

uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

# call METHOD PATH [TOKEN] [JSON]: sets $status and writes the body to $body_file.
call() {
  local method="$1" path="$2" token="${3:-}" json="${4:-}"
  local args=(--silent --show-error --max-time 20 -o "$body_file" -w '%{http_code}' -X "$method")
  [[ -n "$token" ]] && args+=(-H "authorization: Bearer $token")
  [[ -n "$json" ]] && args+=(-H 'content-type: application/json' --data "$json")
  status="$(curl "${args[@]}" "$origin$path")"
}

body() { jq -r "$1" "$body_file"; }

expect() {
  local name="$1" expected_status="$2" expected_code="${3:-}"
  local code
  code="$(jq -r '.errorCode // .error.code // empty' "$body_file" 2>/dev/null || true)"
  step=$((step + 1))
  if [[ "$status" != "$expected_status" ]] || [[ -n "$expected_code" && "$code" != "$expected_code" ]]; then
    echo "FAIL $step $name: expected $expected_status ${expected_code} but got $status ${code}" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
  echo "PASS $step $name"
}

assert() {
  local name="$1"
  shift
  step=$((step + 1))
  if ! "$@" >/dev/null; then
    echo "FAIL $step $name" >&2
    exit 1
  fi
  echo "PASS $step $name"
}

# expect_success NAME: accepts 200 or 201 (create or return an existing row).
expect_success() {
  [[ "$status" == 201 ]] && status=200
  expect "$1" 200
}

# Per-account values live in token_<name> and account_<name> (bash 3 has no
# associative arrays).
tok() { local var="token_$1"; echo "${!var}"; }
acct() { local var="account_$1"; echo "${!var}"; }

signup() {
  local name="$1"
  call POST /v1/cloud/auth/signup "" "$(jq -n --arg email "consent-$name-$(uuid)@example.test" \
    --arg name "Consent $name" \
    '{email: $email, password: "correct horse battery", displayName: $name, avatarSeed: "consent_e2e"}')"
  expect "sign up $name" 201
  printf -v "token_$name" '%s' "$(body .session.token)"
  printf -v "account_$name" '%s' "$(body .account.accountId)"
}

contacts_include() {
  call GET /v1/cloud/contacts "$(tok "$1")"
  jq -e --arg id "$(acct "$2")" 'any(.contacts[]?; .accountId == $id)' "$body_file" >/dev/null
}

presence_includes() {
  call GET /v1/cloud/presence/contacts "$(tok "$1")"
  jq -e --arg id "$(acct "$2")" 'any(.accounts[]?; .accountId == $id)' "$body_file" >/dev/null
}

not() { ! "$@"; }

direct_session() {
  local first second
  first="$(acct "$1")"
  second="$(acct "$2")"
  if [[ "$first" > "$second" ]]; then
    local swap="$first"; first="$second"; second="$swap"
  fi
  echo "session:direct-person:$first:$second"
}

open_direct() {
  call POST /v2/chat/conversations "$(tok "$1")" "$(jq -n --arg op "$(uuid)" \
    --arg session "$(direct_session "$1" "$2")" --arg peer "$(acct "$2")" \
    '{client_operation_id: $op, kind: "direct", shared_title: null, client_session_id: $session, member_account_ids: [$peer]}')"
}

send_text() {
  call POST "/v2/chat/conversations/$2/messages" "$(tok "$1")" "$(jq -n --arg id "$(uuid)" --arg text "$3" \
    '{client_message_id: $id, kind: "text", content: {schema: 1, blocks: [{type: "text", text: $text}]}, reply_to_message_id: null, attachment_ids: []}')"
}

request_contact() {
  call POST /v1/cloud/contacts/requests "$(tok "$1")" "$(jq -n --arg peer "$(acct "$2")" '{peerAccountId: $peer}')"
}

# 1. Fresh accounts (E keeps the group from shrinking to one person).
for name in a b c d e; do signup "$name"; done
for name in a b; do call POST /v1/cloud/presence/online "$(tok "$name")"; done

# 2. The one-sided add only sends a request.
call POST /v1/cloud/contacts "$(tok a)" "$(jq -n --arg peer "$(acct b)" '{peerAccountId: $peer}')"
expect "A adds B: request sent" 202
request_id="$(body .request.requestId)"
assert "A's contacts exclude B" not contacts_include a b

# 3. No direct chat without consent.
open_direct a b
expect "A cannot open a direct chat with B yet" 403 CHAT_RELATIONSHIP_REQUIRED

# 4. Acceptance allows the chat and online status.
call POST "/v1/cloud/contacts/requests/$request_id/accept" "$(tok b)"
expect "B accepts" 200
open_direct a b
expect_success "A opens the direct chat"
chat_id="$(body .conversation.id)"
send_text a "$chat_id" "Hello B"
expect "A sends a message" 201
message_id="$(body .message.id)"
assert "A sees B online" presence_includes a b

# 5. A block closes every channel between them.
call PUT "/v1/cloud/blocks/$(acct a)" "$(tok b)" '{}'
expect "B blocks A" 200
send_text a "$chat_id" "Are you there?"
expect "A can no longer send" 403 CHAT_RELATIONSHIP_REQUIRED
request_contact a b
expect "A cannot send B a request" 403 contact_request_unavailable
request_contact b a
expect "B must unblock first" 409 blocked_account
assert "A no longer sees B online" not presence_includes a b

# 6. Groups, invite previews, and the inviter's block.
for name in c e; do
  request_contact a "$name"
  expect "A requests $name" 201
  call POST "/v1/cloud/contacts/requests/$(body .request.requestId)/accept" "$(tok "$name")"
  expect "$name accepts" 200
done
group_session="session:group:$(uuid | tr -d -)"
call POST /v2/chat/conversations "$(tok a)" "$(jq -n --arg op "$(uuid)" --arg session "$group_session" \
  --arg c "$(acct c)" --arg e "$(acct e)" \
  '{client_operation_id: $op, kind: "group", shared_title: "Consent check", client_session_id: $session, member_account_ids: [$c, $e]}')"
expect_success "A creates a group with C and E"
group_id="$(body .conversation.id)"
call POST /v1/cloud/invitations/groups "$(tok a)" "$(jq -n --arg session "$group_session" \
  '{groupId: $session, groupSpaceId: $session, groupTitle: "Consent check"}')"
expect "A creates an invite link" 200
invite_token="$(body .inviteUrl | awk -F/ '{print $NF}')"
call GET "/v1/cloud/invitations/groups/resolve/$invite_token"
expect "anyone can preview the link" 200
assert "the preview has only the allowed keys" jq -e \
  '(keys == ["expiresAt","group","inviter"]) and ((.inviter | keys) == ["avatarUrl","displayName"]) and ((.group | keys) == ["memberCount","name"])' \
  "$body_file"
assert "the preview has no account id" not grep -q 'acct_' "$body_file"
call PUT "/v1/cloud/blocks/$(acct d)" "$(tok a)" '{}'
expect "A blocks D" 200
call POST "/v1/cloud/invitations/groups/accept/$invite_token" "$(tok d)"
expect "D cannot use A's link" 404 invalid_group_invitation

# 7. Leaving and coming back through the link.
call POST "/v2/chat/conversations/$group_id/leave" "$(tok c)" "$(jq -n --arg op "$(uuid)" \
  '{client_operation_id: $op, successor_account_id: null}')"
expect "C leaves the group" 200
call GET "/v2/chat/conversations/$group_id/messages" "$(tok c)"
expect "C can no longer read the group" 403
call GET "/v2/chat/sync?limit=1000" "$(tok a)"
expect "A syncs" 200
assert "A hears that C left" jq -e --arg group "$group_id" --arg c "$(acct c)" \
  'any(.events[]; .type == "membership.updated" and .conversation_id == $group and any(.payload.conversation.members[]; .account_id == $c and .membership_state == "left"))' \
  "$body_file"
call POST "/v1/cloud/invitations/groups/accept/$invite_token" "$(tok c)"
expect "C rejoins with the same link" 200
assert "C joined again" jq -e '.status == "joined"' "$body_file"

# 8. Reports.
report_body="$(jq -n --arg id "$(uuid)" --arg chat "$chat_id" --arg message "$message_id" \
  '{clientReportId: $id, reason: "harassment", conversationId: $chat, messageIds: [$message]}')"
call POST /v1/cloud/reports "$(tok b)" "$report_body"
expect "B reports A's message" 201
assert "the receipt has a reference" jq -e '.report.reference | test("^R-[0-9A-F]{8}$")' "$body_file"
report_id="$(body .report.reportId)"
call POST /v1/cloud/reports "$(tok b)" "$report_body"
expect "replaying the report returns it again" 200
call GET /v1/cloud/reports "$(tok b)"
expect "B lists reports" 200
assert "B's list has the report" jq -e --arg id "$report_id" 'any(.reports[]; .reportId == $id)' "$body_file"
call GET /v1/cloud/reports "$(tok a)"
expect "A lists reports" 200
assert "A's list is empty" jq -e '.reports == []' "$body_file"

# 9. Unblocking does not restore access to B's agent.
call DELETE "/v1/cloud/blocks/$(acct a)" "$(tok b)"
expect "B unblocks A" 204
call POST /v1/cloud/agent-runs/claim "$(tok a)" "$(jq -n --arg message "$message_id" \
  --arg session "$(direct_session a b)" --arg owner "$(acct b)" --arg requester "$(acct a)" \
  --arg key "consent-e2e:$(uuid)" \
  '{requestMessageId: $message, sessionId: $session, ownerAccountId: $owner, requesterAccountId: $requester, prompt: "@Kordi help", idempotencyKey: $key}')"
expect "A cannot use B's agent" 403 agent_not_available

echo "All $step consent checks passed against $origin"
