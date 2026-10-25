-- How many `search_memory` answers the active evaluation of an agent's group
-- has had (docs/development/proactive-agent.md, "Memory"). The sweep resets
-- it when it reserves a new evaluation; each search counts one while fewer
-- than three were answered, so the Mac attempt and a cloud takeover share
-- one budget. Existing rows start at zero.
ALTER TABLE cloud_agent_proactive_state
    ADD COLUMN IF NOT EXISTS memory_searches INTEGER NOT NULL DEFAULT 0;
