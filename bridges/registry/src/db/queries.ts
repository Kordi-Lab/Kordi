import Database from 'better-sqlite3';
import type {
  NodeRow,
  ProjectRow,
  ProjectAgentRow,
  InviteRow,
  AgentSkillRow,
} from './schema.js';

export type JoinInviteResult =
  | { ok: true; projectId: string; nodeId: string }
  | { ok: false; status: number; error: string };

// ── Nodes ───────────────────────────────────────────────────────────

export function insertNode(
  db: Database.Database,
  row: Omit<NodeRow, 'created_at'>
): void {
  db.prepare(`
    INSERT INTO nodes (node_id, display_name, runtime, endpoint, public_key, owner_name, token_hash)
    VALUES (@node_id, @display_name, @runtime, @endpoint, @public_key, @owner_name, @token_hash)
  `).run(row);
}

export function getNode(db: Database.Database, nodeId: string): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(nodeId) as NodeRow | undefined;
}

export function getNodeByTokenHash(db: Database.Database, hash: string): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(hash) as NodeRow | undefined;
}

export function updateNode(
  db: Database.Database,
  nodeId: string,
  fields: Partial<Pick<NodeRow, 'endpoint' | 'display_name' | 'runtime' | 'public_key'>>
): boolean {
  const sets: string[] = [];
  const values: Record<string, string> = { node_id: nodeId };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      sets.push(`${k} = @${k}`);
      values[k] = v;
    }
  }
  if (sets.length === 0) return false;
  const result = db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE node_id = @node_id`).run(values);
  return result.changes > 0;
}

export function updateNodeTokenHash(db: Database.Database, nodeId: string, tokenHash: string): boolean {
  const result = db.prepare('UPDATE nodes SET token_hash = ? WHERE node_id = ?').run(tokenHash, nodeId);
  return result.changes > 0;
}

export function listNodes(db: Database.Database): NodeRow[] {
  return db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all() as NodeRow[];
}

export function listVisibleNodesForNode(db: Database.Database, nodeId: string): NodeRow[] {
  return db.prepare(`
    SELECT DISTINCT n.*
    FROM nodes n
    WHERE n.node_id = @requester_node_id
       OR EXISTS (
            SELECT 1
            FROM project_agents mine
            JOIN project_agents other
              ON mine.project_id = other.project_id
            WHERE mine.node_id = @requester_node_id
              AND mine.status = 'active'
              AND other.status = 'active'
              AND other.node_id = n.node_id
       )
    ORDER BY n.created_at DESC
  `).all({ requester_node_id: nodeId }) as NodeRow[];
}

export function getVisibleNodeForNode(
  db: Database.Database,
  requesterNodeId: string,
  targetNodeId: string
): NodeRow | undefined {
  return db.prepare(`
    SELECT DISTINCT n.*
    FROM nodes n
    WHERE n.node_id = @target_node_id
      AND (
        n.node_id = @requester_node_id
        OR EXISTS (
          SELECT 1
          FROM project_agents mine
          JOIN project_agents other
            ON mine.project_id = other.project_id
          WHERE mine.node_id = @requester_node_id
            AND mine.status = 'active'
            AND other.status = 'active'
            AND other.node_id = n.node_id
        )
      )
  `).get({
    requester_node_id: requesterNodeId,
    target_node_id: targetNodeId,
  }) as NodeRow | undefined;
}

// ── Projects ────────────────────────────────────────────────────────

export function insertProject(
  db: Database.Database,
  row: Omit<ProjectRow, 'created_at' | 'status'>
): void {
  db.prepare(`
    INSERT INTO projects (project_id, slug, display_name, description, owner_node_id)
    VALUES (@project_id, @slug, @display_name, @description, @owner_node_id)
  `).run(row);
}

export function getProject(db: Database.Database, projectId: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined;
}

export function listProjectsForNode(db: Database.Database, nodeId: string): ProjectRow[] {
  return db.prepare(`
    SELECT p.* FROM projects p
    WHERE p.owner_node_id = ?
       OR EXISTS (SELECT 1 FROM project_agents pa WHERE pa.project_id = p.project_id AND pa.node_id = ? AND pa.status = 'active')
    ORDER BY p.created_at DESC
  `).all(nodeId, nodeId) as ProjectRow[];
}

export function updateProject(
  db: Database.Database,
  projectId: string,
  fields: Partial<Pick<ProjectRow, 'display_name' | 'description' | 'slug' | 'status'>>
): boolean {
  const sets: string[] = [];
  const values: Record<string, string> = { project_id: projectId };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      sets.push(`${k} = @${k}`);
      values[k] = v;
    }
  }
  if (sets.length === 0) return false;
  const result = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE project_id = @project_id`).run(values);
  return result.changes > 0;
}

// ── Project Agents ──────────────────────────────────────────────────

export function insertProjectAgent(
  db: Database.Database,
  row: Omit<ProjectAgentRow, 'joined_at' | 'status'>
): void {
  db.prepare(`
    INSERT INTO project_agents (project_id, node_id, owner_name, agent_role, permissions_json)
    VALUES (@project_id, @node_id, @owner_name, @agent_role, @permissions_json)
  `).run(row);
}

export function getProjectAgents(db: Database.Database, projectId: string): ProjectAgentRow[] {
  return db.prepare(
    "SELECT * FROM project_agents WHERE project_id = ? AND status = 'active'"
  ).all(projectId) as ProjectAgentRow[];
}

export function isProjectMember(db: Database.Database, projectId: string, nodeId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM project_agents WHERE project_id = ? AND node_id = ? AND status = 'active'"
  ).get(projectId, nodeId);
  return row !== undefined;
}

// ── Invites ─────────────────────────────────────────────────────────

export function insertInvite(
  db: Database.Database,
  row: Omit<InviteRow, 'created_at' | 'use_count'>
): void {
  db.prepare(`
    INSERT INTO invites (invite_id, project_id, token_hash, created_by, max_uses, expires_at)
    VALUES (@invite_id, @project_id, @token_hash, @created_by, @max_uses, @expires_at)
  `).run(row);
}

export function getInviteByTokenHash(db: Database.Database, tokenHash: string): InviteRow | undefined {
  return db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash) as InviteRow | undefined;
}

export function getInvite(db: Database.Database, inviteId: string): InviteRow | undefined {
  return db.prepare('SELECT * FROM invites WHERE invite_id = ?').get(inviteId) as InviteRow | undefined;
}

export function getInviteByIdAndProject(
  db: Database.Database,
  inviteId: string,
  projectId: string
): InviteRow | undefined {
  return db.prepare('SELECT * FROM invites WHERE invite_id = ? AND project_id = ?').get(inviteId, projectId) as InviteRow | undefined;
}

export function incrementInviteUse(db: Database.Database, inviteId: string): void {
  db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE invite_id = ?').run(inviteId);
}

export function listInvites(db: Database.Database, projectId: string): InviteRow[] {
  return db.prepare('SELECT * FROM invites WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as InviteRow[];
}

export function deleteInvite(db: Database.Database, inviteId: string): boolean {
  const result = db.prepare('DELETE FROM invites WHERE invite_id = ?').run(inviteId);
  return result.changes > 0;
}

export function joinProjectWithInvite(
  db: Database.Database,
  projectId: string,
  tokenHash: string,
  joinNodeId: string,
  agentRole: string
): JoinInviteResult {
  const tx = db.transaction((): JoinInviteResult => {
    const invite = db.prepare(
      'SELECT * FROM invites WHERE project_id = ? AND token_hash = ?'
    ).get(projectId, tokenHash) as InviteRow | undefined;

    if (!invite) {
      return { ok: false, status: 400, error: 'Invalid invite token' };
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return { ok: false, status: 410, error: 'Invite has expired' };
    }

    if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
      return { ok: false, status: 410, error: 'Invite has reached max uses' };
    }

    const existingMember = db.prepare(
      "SELECT 1 FROM project_agents WHERE project_id = ? AND node_id = ? AND status = 'active'"
    ).get(projectId, joinNodeId);
    if (existingMember) {
      return { ok: false, status: 409, error: 'Already a member' };
    }

    const node = db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(joinNodeId) as NodeRow | undefined;
    if (!node) {
      return { ok: false, status: 404, error: 'Node not found' };
    }

    db.prepare(`
      INSERT INTO project_agents (project_id, node_id, owner_name, agent_role, permissions_json)
      VALUES (@project_id, @node_id, @owner_name, @agent_role, @permissions_json)
    `).run({
      project_id: projectId,
      node_id: joinNodeId,
      owner_name: node.owner_name,
      agent_role: agentRole,
      permissions_json: null,
    });

    db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE invite_id = ?').run(invite.invite_id);

    return { ok: true, projectId, nodeId: joinNodeId };
  });

  return tx();
}

// ── Agent Skills ────────────────────────────────────────────────────

export function insertSkill(
  db: Database.Database,
  row: Omit<AgentSkillRow, 'created_at'>
): void {
  db.prepare(`
    INSERT INTO agent_skills (skill_id, node_id, project_id, name, description)
    VALUES (@skill_id, @node_id, @project_id, @name, @description)
  `).run(row);
}

export function listSkills(db: Database.Database, projectId: string): AgentSkillRow[] {
  return db.prepare('SELECT * FROM agent_skills WHERE project_id = ? ORDER BY name').all(projectId) as AgentSkillRow[];
}

export function getSkill(db: Database.Database, skillId: string): AgentSkillRow | undefined {
  return db.prepare('SELECT * FROM agent_skills WHERE skill_id = ?').get(skillId) as AgentSkillRow | undefined;
}

export function deleteSkill(db: Database.Database, skillId: string): boolean {
  const result = db.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(skillId);
  return result.changes > 0;
}
