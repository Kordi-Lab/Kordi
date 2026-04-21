export const APP_PROTOCOL_VERSION = 'app/v0alpha1';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ClientKind = 'desktop' | 'tui' | 'automation' | 'test';
export type ServiceState = 'unknown' | 'starting' | 'ready' | 'degraded' | 'error';
export type SessionSource = 'local' | 'project' | 'peer';
export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'failed';
export type ProjectStatus = 'active' | 'archived' | 'invited';
export type PeerKind = 'human' | 'agent';
export type PeerStatus = 'online' | 'offline' | 'reachable' | 'unknown';
export type TimelineEntryKind = 'message' | 'status' | 'approval' | 'artifact' | 'system';
export type TimelineRole = 'user' | 'assistant' | 'tool' | 'system' | 'peer' | 'bridge';
export type TimelineState = 'streaming' | 'complete' | 'error';
export type ArtifactKind = 'file' | 'image' | 'url';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ApprovalDecision = 'approve_once' | 'deny' | 'abort_turn';
export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'waiting_approval';

export type ClientMetadata = {
  client_id: string;
  client_kind: ClientKind;
  client_name: string;
  protocol_version: string;
  supports_streaming: boolean;
  supports_rich_text: boolean;
};

export type ServerMetadata = {
  protocol_version: string;
  server_name: string;
  server_version: string;
  transport: 'http+sse';
};

export type WorkspaceSummary = {
  cwd: string;
  root_name: string;
  platform: string;
  execution_mode: string;
};

export type ServiceStatusSummary = {
  state: ServiceState;
  detail?: string;
  last_heartbeat_at?: string;
};

export type ServiceSnapshot = {
  runtime: ServiceStatusSummary;
  bridges: ServiceStatusSummary;
  registry?: ServiceStatusSummary;
};

export type FeatureFlags = {
  session_streaming: boolean;
  tool_approval: boolean;
  projects: boolean;
  peers: boolean;
};

export type BootstrapSnapshot = {
  server: ServerMetadata;
  client: ClientMetadata;
  workspace: WorkspaceSummary;
  services: ServiceSnapshot;
  features: FeatureFlags;
  current_session_id?: string;
};

export type SessionSummary = {
  session_id: string;
  title: string;
  source: SessionSource;
  status: SessionStatus;
  updated_at: string;
  cwd?: string;
  project_id?: string;
  peer_id?: string;
  last_message_preview?: string;
  unread_count: number;
};

export type SessionsPage = {
  items: SessionSummary[];
  next_cursor?: string;
};

export type ProjectSummary = {
  project_id: string;
  slug?: string;
  title: string;
  status: ProjectStatus;
  member_count: number;
  unread_count: number;
};

export type ProjectsPage = {
  items: ProjectSummary[];
  next_cursor?: string;
};

export type PeerSummary = {
  peer_id: string;
  display_name: string;
  kind: PeerKind;
  status: PeerStatus;
  reachable_via?: string[];
};

export type PeersPage = {
  items: PeerSummary[];
  next_cursor?: string;
};

export type TimelineEntry = {
  session_id: string;
  entry_id: string;
  parent_entry_id?: string;
  created_at: string;
  kind: TimelineEntryKind;
  role: TimelineRole;
  text?: string;
  detail?: string;
  state?: TimelineState;
  data?: JsonValue;
};

export type SessionDetail = {
  session: SessionSummary;
  entries: TimelineEntry[];
  has_more: boolean;
  next_cursor?: string;
};

export type ArtifactRef = {
  artifact_id: string;
  label: string;
  kind: ArtifactKind;
  path?: string;
  url?: string;
  mime_type?: string;
};

export type ModelSelector = {
  provider?: string;
  model_id: string;
  reasoning?: ThinkingLevel;
};

export type SubmitTurnRequest = {
  session_id?: string;
  title?: string;
  input: string;
  cwd?: string;
  project_id?: string;
  peer_id?: string;
  model?: ModelSelector;
  thinking?: ThinkingLevel;
  new_session?: boolean;
  attachments?: ArtifactRef[];
};

export type SubmitTurnAccepted = {
  turn_id: string;
  session_id: string;
  created_session: boolean;
  stream_url: string;
};

export type UsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_microunits?: number;
};

export type ToolApprovalRequest = {
  approval_id: string;
  turn_id: string;
  session_id: string;
  tool_name: string;
  summary: string;
  command?: string;
  working_directory?: string;
  reason?: string;
  created_at: string;
};

export type SessionEvent =
  | {
      type: 'snapshot';
      detail: SessionDetail;
      cursor?: string;
    }
  | {
      type: 'session_upserted';
      session: SessionSummary;
    }
  | {
      type: 'session_deleted';
      session_id: string;
    }
  | {
      type: 'turn_started';
      session_id: string;
      turn_id: string;
      submitted_at: string;
      input: string;
    }
  | {
      type: 'entry_delta';
      session_id: string;
      turn_id: string;
      entry_id: string;
      delta: string;
    }
  | {
      type: 'entry_committed';
      session_id: string;
      turn_id?: string;
      entry: TimelineEntry;
    }
  | {
      type: 'approval_requested';
      approval: ToolApprovalRequest;
    }
  | {
      type: 'approval_resolved';
      approval_id: string;
      decision: ApprovalDecision;
      resolved_at: string;
    }
  | {
      type: 'turn_finished';
      session_id: string;
      turn_id: string;
      outcome: TurnOutcome;
      usage?: UsageSummary;
      error?: string;
    }
  | {
      type: 'services_updated';
      services: ServiceSnapshot;
    };
