import Database from 'better-sqlite3';

/** Initialize database schema. Idempotent — safe to call on every startup. */
export function initSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id       TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      runtime       TEXT NOT NULL,
      endpoint      TEXT NOT NULL,
      public_key    TEXT,
      owner_name    TEXT NOT NULL,
      token_hash    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id    TEXT PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      description   TEXT,
      owner_node_id TEXT NOT NULL REFERENCES nodes(node_id),
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_agents (
      project_id       TEXT NOT NULL REFERENCES projects(project_id),
      node_id          TEXT NOT NULL REFERENCES nodes(node_id),
      owner_name       TEXT,
      agent_role       TEXT,
      permissions_json TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      joined_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      invite_id   TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(project_id),
      token_hash  TEXT NOT NULL,
      created_by  TEXT NOT NULL REFERENCES nodes(node_id),
      max_uses    INTEGER,
      use_count   INTEGER NOT NULL DEFAULT 0,
      expires_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      skill_id    TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL REFERENCES nodes(node_id),
      project_id  TEXT NOT NULL REFERENCES projects(project_id),
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_token_hash ON nodes(token_hash);
    CREATE INDEX IF NOT EXISTS idx_projects_owner_node_id ON projects(owner_node_id);
    CREATE INDEX IF NOT EXISTS idx_project_agents_project_id ON project_agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_agents_node_id ON project_agents(node_id);
    CREATE INDEX IF NOT EXISTS idx_invites_project_id ON invites(project_id);
    CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_skills_project_id ON agent_skills(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_skills_node_id ON agent_skills(node_id);
  `);
}

/** Row types matching the SQLite schema. */
export interface NodeRow {
  node_id: string;
  display_name: string;
  runtime: string;
  endpoint: string;
  public_key: string | null;
  owner_name: string;
  token_hash: string;
  created_at: string;
}

export interface ProjectRow {
  project_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  owner_node_id: string;
  status: string;
  created_at: string;
}

export interface ProjectAgentRow {
  project_id: string;
  node_id: string;
  owner_name: string | null;
  agent_role: string | null;
  permissions_json: string | null;
  status: string;
  joined_at: string;
}

export interface InviteRow {
  invite_id: string;
  project_id: string;
  token_hash: string;
  created_by: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface AgentSkillRow {
  skill_id: string;
  node_id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
}
