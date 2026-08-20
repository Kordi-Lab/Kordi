---
name: agent-creator
description: Create and refine a Kordi agent draft as real workspace files.
---

# Agent creator

Use this skill whenever the user asks to create or change the agent in this workspace.

The draft is defined by these files:

- `agent.json`: structured metadata, model route, access policy, tools, and skill references.
- `SYSTEM_PROMPT.md`: the exact system prompt for the candidate agent.
- `skills/<skill-name>/SKILL.md`: one complete skill package for every skill referenced by `agent.json`.

## Required workflow

1. Read the existing draft files before proposing a change.
2. Ask a concise follow-up only when a missing choice materially changes the result.
3. Use `write` or `edit` to make the requested change. A prose proposal is not a completed change.
4. Keep names, descriptions, prompts, and file contents in English.
5. Keep the tool list minimal. Never add shell, network, outreach, scheduling, or session-reading tools unless the product explicitly supports and the user explicitly requests them.
6. After editing, summarize the files changed and ask the user to run the draft test before publishing.

The Factory conversation's own file tools and private workspace are only for editing the draft. They are not the candidate agent's runtime limits. Configure the candidate from the user's request and the capabilities shown in Factory. For example, a request for current web research calls for `web_search` and `web_fetch` when those tools are available.

Preserve the configured model route already present in `agent.json`. Do not replace it with a model from an example or guess another model ID. If no route is configured, leave the provider and model as `null` so Kordi can use the active authenticated route.

## `agent.json` shape

```json
{
  "name": "Agent name",
  "role": "Focused responsibility",
  "description": "One-sentence purpose",
  "sourceSummary": "What this agent is grounded in",
  "boundaries": ["A concrete limit"],
  "model": {
    "provider": null,
    "model": null,
    "thinking": null
  },
  "access": "only-me",
  "tools": [],
  "plugins": [],
  "skills": [
    {
      "name": "skill-name",
      "description": "What the skill enables",
      "path": "skills/skill-name/SKILL.md"
    }
  ]
}
```

Do not invent a successful validation or runtime test. Kordi performs those checks outside the conversation.
