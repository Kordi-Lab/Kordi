# Contact permissions

On a person's profile, the owner can turn off two things for that one person. Both are on by default, which is the behavior without any setting.

| Switch | When off, that person |
|---|---|
| **Use my agent** | cannot start, address, mention, or delegate to any of the owner's agents (the default agent and shared agents), in direct chats, groups, documents, follow-up threads, or agent exchanges. The owner's agents do not act on their requests and do not read their messages. |
| **See my card** | never receives the owner's Grounding card or its topics, on any route. The owner looks the way a person whose card is not shared looks. |

## Rules

- **Private.** The person is never told. A refused agent request gets the same `403 agent_not_available` ("This agent isn't available.") as any agent they may not use, and a request ended by the restriction is answered with that same line. A hidden card answers exactly like a card that is not shared: `404 common_ground_person_not_found`, `hasCard: false`, or left out of a list.
- **One-directional.** Restricting someone changes nothing about what you can do with their agent or see of their card.
- **Kept with the account, not the contact.** Removing and re-adding a contact keeps the switches. Deleting either account deletes them.
- **Defaults.** A missing row allows both.

## What "Use my agent" off blocks

The server checks every path where another account's request reaches one of your agents:

- Run claims from their client (`POST /v1/cloud/agent-runs/claim`) and from your Mac (`POST /v1/cloud/agent-runs/desktop/claim`), including group @mentions, direct agent chats, shared agents, and agent-to-agent handoffs. Every claim path admits runs through one function, which refuses them too.
- Agent exchanges: their agent's `reach_out` directory leaves your agents out, also when their agent reaches out on someone else's behalf, and exchange runs already sent are not authorized anymore.
- Follow-up threads (subsessions) and the task-operator tool.
- `@agent` in document comments.
- The shared-agent list (`GET /v1/cloud/agents/shared`) leaves out your shared agents for them.
- **Shared groups.** Your agent stays in groups you share with them, but it does not answer them and does not read their messages: they are left out of the conversation history a run sees, of the messages its context tools read, and of what wakes your Cooperative agent.
- **Requests already in flight.** Turning the switch off ends their waiting and running runs with the generic reply; a run leased later for them ends the same way. Saving a switch and admitting a run take the same lock, so no run slips in between.
- **Your Mac.** When your Mac answers (the Mac-first route), it reads your restricted list (`GET /v1/cloud/contacts/permissions`, refreshed every 15 seconds and at once after you change a switch), never answers their requests, leaves their messages out of the context it builds, and posts nothing in the conversation when the server refuses a claim.

## Agent access

Every agent has an **Access** setting, the default Kordi agent included: the default agent is a ready-made Factory agent with the same setting.

| Access | Who can use the agent |
|---|---|
| **People in my chats can mention it** (`participant_conversations`) | The owner, and people in the owner's direct and group chats. The default. |
| **Only me** (`private`) | The owner only. |

- **Defaults.** The default agent with nothing stored, and every new Factory agent, is open (`participant_conversations`). Existing Factory agents keep their stored value.
- **How it combines.** Another person may use an agent only when its Access is open **and** the owner's "Use my agent" switch for that person is on. The owner is never refused.
- **Every path.** The same check covers every path listed under "Use my agent" above: claims from their client and from your Mac, group @mentions, direct agent chats, shared and personal agents, agent exchanges and the `reach_out` directory, follow-up threads and the task-operator tool, `@agent` in documents (a public reader cannot ask a private default agent), and the shared-agent list. Runs leased later are re-checked.
- **Private.** A refused request gets the same `403 agent_not_available` ("This agent isn't available.").
- **Requests already in flight.** Changing an agent to "Only me" ends other people's waiting and running requests to that agent with the generic reply. Saving Access and admitting a run take the same owner lock, so no run slips in between.
- **API.** `GET /v1/cloud/agents/:agent_id/access` → `{ "agentId", "accessScope" }`, and `PUT` with `{ "accessScope": "private" | "participant_conversations" }`, owner only. `agent_id` is a Factory agent id or the default agent, `cloud-agent:<account_id>`. Factory agents also keep `accessScope` on `PUT /v1/cloud/agents/:agent_id`.
- **Data.** Factory agents: `cloud_agent_definitions.access_scope`. Default agent: `cloud_default_agent_profiles.access_scope` (migration 0186); `NULL` means `participant_conversations`.
- **Mac.** The Factory shows the default agent's real Access with the same menu as Factory agents and publishes it through the route above.

## What "See my card" off hides

Every Common ground read path: `people/:id`, match detail and Recent, room lobbies (`hasCard: false`) and room results and themes, pairing results, the Common ground card on the contact profile, Nearby lists, person pages and alerts, and Add, Chat and Meet through Grounding. Group intros and joined lines quote no topics when anyone they name has restricted another of them.

## API

- `GET /v1/cloud/contacts/:account_id/permissions` → `{ "accountId", "agentAccess", "cardAccess", "updatedAt" }`.
- `PUT /v1/cloud/contacts/:account_id/permissions` with `{ "agentAccess"?: bool, "cardAccess"?: bool }`; a missing key keeps its value.
- `GET /v1/cloud/contacts/permissions` → `{ "people": [...] }`: everyone you restricted in any way, same fields.
- Both answer for an accepted contact, someone you share an active conversation with, or anyone you already set permissions for; otherwise `404 contact_not_found`.
- The contact profile (`GET /v1/cloud/contacts/:account_id/profile`) carries `permissions` for a person who is not yourself.
- The capability is `contactPermissionsVersion: 1`.
- Data: `cloud_contact_permissions` (migration 0184).

## Clients

- **iOS:** a **Permissions** row on the person's profile opens a settings-style page with **Use my agent** and **See my card**. Preview with `--preview-contact-permissions`.
- **Mac:** a **Permissions** section on the contact profile with the same two switches, and in the member popover of a shared conversation, which also reaches people who are not contacts. Preview at `tests/visual/contactPermissionsPreview.html`.
