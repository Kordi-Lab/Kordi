export type NavId = 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
export type ChatFilter = 'all' | 'people' | 'agents' | 'delegated';
export type DetailTab = 'info' | 'context' | 'artifacts' | 'tasks';
export type ConversationType = 'person' | 'owned-agent' | 'external-agent';
export type ContactClass = 'my-agents' | 'other-users-agents' | 'other-users';
export type ResizeDirection =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';
export type PanelResizeTarget = 'session' | 'detail';
export type ThemeMode = 'dark' | 'light';
export type ComposerScope = 'chat' | 'project';
export type ComposerSelectorType = 'mode' | 'model' | 'thinking';

export type EditDiffLine = {
  kind: 'context' | 'add' | 'remove';
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type SourcePreviewLine = {
  number: number;
  text: string;
  kind?: 'context' | 'add';
};

export type EditFilePreview = {
  path: string;
  additions: number;
  deletions: number;
  lines: EditDiffLine[];
  sourceLines?: SourcePreviewLine[];
};

export type Message = {
  role: 'system' | 'user' | 'owned-agent' | 'external-agent' | 'person' | 'action' | 'edit';
  sender?: string;
  text: string;
  time: string;
  detail?: string;
  edit?: {
    files: EditFilePreview[];
  };
};

export type Conversation = {
  id: string;
  name: string;
  type: ConversationType;
  subtitle: string;
  unread: number;
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
  messages: Message[];
};

export type Contact = {
  id: string;
  name: string;
  initials: string;
  classType: ContactClass;
  entityType: string;
  subtitle: string;
  bridges: string[];
  status: string;
  discoverableOn: string[];
  detail: string;
  owner: string;
};

export type ContactRequest = {
  id: string;
  initials: string;
  title: string;
  detail: string;
  time: string;
};

export type Agent = {
  name: string;
  id: string;
  role: string;
  messaging: string;
  status: string;
  tasks: number;
  defaultProvider: string;
  defaultModel: string;
  bridgesConfig: string;
  contactId: string;
  systemPrompt: string;
  xMd: string;
  lastActivities: string[];
};

export type ProjectSession = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  status: string;
  participants: string[];
  artifacts: number;
  tasks: number;
  messages: Message[];
};

export type Project = {
  id: string;
  name: string;
  summary: string;
  bridge: string;
  scope: string;
  status: string;
  people: string[];
  agents: string[];
  pendingInvites: string[];
  artifacts: number;
  tasks: number;
  sessions: ProjectSession[];
};
