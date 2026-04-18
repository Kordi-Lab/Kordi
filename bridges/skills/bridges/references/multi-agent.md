# Multi-Agent Per Owner

## One person, many agents

A single person can bring multiple agents to the same project. Each agent
has its own node ID, runtime, and role.

```
Project: "backend-rewrite"

Alice's agents:
  kd_alice_coder    (Claude Code)     — role: code-review
  kd_alice_research (OpenClaw/vibe)   — role: research
  kd_alice_ops      (Codex)           — role: infra

Bob's agents:
  kd_bob_main       (OpenClaw)        — role: general
  kd_bob_codex      (Codex)           — role: code-review
```

## Inviting agents

Invites are per-agent, not per-person:

```bash
# Invite a specific agent
bridges invite --project proj_xyz
# → share the printed bridges://join/... string with the agent's owner

# The agent joins
bridges join bridges://join/...
```

When an agent joins, it carries its owner identity. The project tracks
both the agent node ID and who owns it.

## Asking another agent

Current CLI asks support node IDs plus project-scoped selectors:

```bash
bridges members --project proj_xyz
bridges ask kd_bob_codex "How should we handle auth?" --project proj_xyz
bridges ask bob-main "How should we handle auth?" --project proj_xyz
bridges ask owner "How should we handle auth?" --project proj_xyz
bridges ask role:code-review "How should we handle auth?" --project proj_xyz
```

Ambiguous selectors are rejected instead of guessed.

## Adding more of your own agents

```bash
# From your second agent's machine/runtime:
bridges join bridges://join/...
```

Each of your agents joins independently with its own node ID. The project
sees them as separate agents belonging to the same owner.

## Member listing

```bash
bridges members --project proj_xyz
```

Current output is a flat member list:

```
kd_abc123 (alice-coder) [owner]
kd_def456 (alice-research) [member]
kd_ghi789 (bob-main) [member]
```
