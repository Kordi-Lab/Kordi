import {
  Activity,
  ArrowRightLeft,
  Bot,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Network,
  Settings,
  Sparkles,
  User,
} from 'lucide-react';

import { DEFAULT_BRIDGE_OWNER_NAME } from '@/features/bridge/constants';

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'configuration'
  | 'auth'
  | 'personalization'
  | 'usage'
  | 'mcp'
  | 'git'
  | 'environments'
  | 'worktrees'
  | 'archived';

export type SettingsControl =
  | { type: 'select'; iconGlyph?: string }
  | { type: 'toggle'; enabled: boolean }
  | { type: 'action'; actionLabel?: string }
  | { type: 'theme' };

export type SettingsItem = {
  label: string;
  value: string;
  hint: string;
  control?: SettingsControl;
};

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  icon: typeof Settings;
  title: string;
  description: string;
  items: SettingsItem[];
};

export const settingsSections: SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings,
    title: 'General',
    description: 'Everyday app behavior, editor opening, send behavior, and other defaults you are likely to touch first.',
    items: [
      {
        label: 'Default open destination',
        value: 'Sublime Text',
        hint: 'Which editor or app opens files and folders from chats, projects, and reviews',
        control: { type: 'select', iconGlyph: 'S' },
      },
      {
        label: 'Language',
        value: 'Auto Detect',
        hint: 'Language for the app UI',
        control: { type: 'select' },
      },
      {
        label: 'Thread detail',
        value: 'Steps with code commands',
        hint: 'How much runtime detail stays visible in chat transcripts',
        control: { type: 'select' },
      },
      {
        label: 'Show in menu bar',
        value: 'On',
        hint: 'Keep Kordi in the macOS menu bar when the main window is closed',
        control: { type: 'toggle', enabled: true },
      },
      {
        label: 'Popout Window hotkey',
        value: 'Off',
        hint: 'Set a global shortcut for Popout Window. Leave unset to keep it off.',
        control: { type: 'action', actionLabel: 'Set' },
      },
      {
        label: 'Prevent sleep while running',
        value: 'Off',
        hint: 'Keep your Mac awake while Kordi is actively running a thread.',
        control: { type: 'toggle', enabled: false },
      },
      {
        label: 'Require cmd + enter to send long prompts',
        value: 'Off',
        hint: 'When enabled, multiline prompts require cmd + enter to send.',
        control: { type: 'toggle', enabled: false },
      },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Sparkles,
    title: 'Appearance',
    description: 'Theme, density, and motion settings that change how the whole app feels day to day.',
    items: [
      { label: 'Theme', value: 'Obsidian', hint: 'Primary interface palette for all bridge surfaces.', control: { type: 'theme' } },
      { label: 'Accent behavior', value: 'Icon-only highlight', hint: 'Selected rail items emphasize icon color instead of background pills.' },
      { label: 'Surface density', value: 'Tight', hint: 'Uses smaller text and denser spacing by default.' },
      { label: 'Motion', value: 'Subtle', hint: 'Keeps page transitions and overlays restrained.' },
    ],
  },
  {
    id: 'configuration',
    label: 'Providers & defaults',
    icon: KeyRound,
    title: 'Providers & Defaults',
    description: 'Pick the default providers, bridge, and safety rules Kordi should reach for before you change them per-chat.',
    items: [
      { label: 'Primary provider', value: 'OpenAI', hint: 'Used by default for new general-purpose agents.' },
      { label: 'Fallback provider', value: 'Anthropic', hint: 'Activated when route policy prefers external completion.' },
      { label: 'Default bridge', value: 'Alpha', hint: 'New sessions and contacts inherit this bridge first.' },
      { label: 'Approval policy', value: 'Restricted outbound only', hint: 'Requests approval before sensitive external actions.' },
    ],
  },
  {
    id: 'auth',
    label: 'Authentication',
    icon: KeyRound,
    title: 'Authentication',
    description: 'Connect Kordi to model providers, manage saved accounts and keys, and switch which access method is active.',
    items: [],
  },
  {
    id: 'personalization',
    label: 'Personalization',
    icon: User,
    title: 'Personalization',
    description: 'My display identity, profile defaults, and workspace preferences that follow me across chats and projects.',
    items: [
      { label: 'Display name', value: DEFAULT_BRIDGE_OWNER_NAME, hint: 'Shown to peers and their agents in shared spaces.' },
      { label: 'Primary contact ID', value: 'contact://primary-user', hint: 'Used for direct reachability and trusted introductions.' },
      { label: 'Default intro style', value: 'Concise and technical', hint: 'Applied to first-contact drafts and summaries.' },
      { label: 'Personal memory mode', value: 'Scoped by project', hint: 'Keeps recall separate across collaboration spaces.' },
    ],
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: Activity,
    title: 'Usage',
    description: 'What Kordi has been doing lately: active sessions, handoffs, compactions, and local storage use.',
    items: [
      { label: 'Active sessions today', value: '18', hint: 'Includes direct chats, delegations, and project threads.' },
      { label: 'Bridge handoffs', value: '7', hint: 'Cross-runtime requests sent through the local gateway.' },
      { label: 'Recent compactions', value: '3', hint: 'Token-aware session compactions in the last 24 hours.' },
      { label: 'Storage footprint', value: '2.4 GB', hint: 'Local sessions, artifacts, and cached workspace state.' },
    ],
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: Network,
    title: 'MCP Servers',
    description: 'Connected MCP servers, how Kordi prefers them, and what happens when one is unavailable.',
    items: [
      { label: 'Connected servers', value: '5 active', hint: 'Local, GitHub, bridge telemetry, notes, and prompt packs.' },
      { label: 'Latency policy', value: 'Prefer local first', hint: 'Uses lower-latency local MCP endpoints whenever possible.' },
      { label: 'Auth refresh', value: 'Automatic', hint: 'Refreshes compatible connectors before expiration.' },
      { label: 'Fallback mode', value: 'Graceful degradation', hint: 'UI keeps loading even if one server becomes unavailable.' },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    icon: FolderOpen,
    title: 'Git',
    description: 'Git defaults for fetching, review behavior, and how carefully Kordi should protect local work.',
    items: [
      { label: 'Auto-fetch', value: 'Manual', hint: 'Repository data refreshes only when you request it.' },
      { label: 'Conflict policy', value: 'Never overwrite local work', hint: 'Protects edited files and user changes by default.' },
      { label: 'Review mode', value: 'Findings first', hint: 'Shows bugs and regressions before summaries.' },
      { label: 'Branch preference', value: 'Current workspace branch', hint: 'New tasks stay aligned with the active branch.' },
    ],
  },
  {
    id: 'environments',
    label: 'Environments',
    icon: Bot,
    title: 'Environments',
    description: 'Which environment Kordi runs in, which shell it prefers, and what local capabilities are available.',
    items: [
      { label: 'Primary environment', value: 'Local worktree', hint: 'Uses your current workspace as the default execution environment.' },
      { label: 'Shell', value: 'zsh', hint: 'Default interactive shell for commands and scripts.' },
      { label: 'Python access', value: 'Available', hint: 'Used only when simpler shell edits are not suitable.' },
      { label: 'Network mode', value: 'Enabled', hint: 'Allows bridge checks, docs lookup, and remote actions when needed.' },
    ],
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    icon: ArrowRightLeft,
    title: 'Worktrees',
    description: 'How new worktrees are named, when they are cleaned up, and which caches stay shared.',
    items: [
      { label: 'Default pattern', value: 'feature/<task>', hint: 'Suggested naming scheme for new worktrees.' },
      { label: 'Cleanup policy', value: 'Manual review', hint: 'Leaves worktrees intact until you confirm cleanup.' },
      { label: 'Shared caches', value: 'Enabled', hint: 'Speeds up installs and builds across sibling worktrees.' },
      { label: 'Archived snapshots', value: 'Keep metadata only', hint: 'Preserves branch references without full workspace state.' },
    ],
  },
  {
    id: 'archived',
    label: 'Archived chats',
    icon: MessageSquare,
    title: 'Archived Chats',
    description: 'How archived chats stay searchable, how they restore, and what metadata remains attached.',
    items: [
      { label: 'Retention', value: '180 days', hint: 'Archived chats remain searchable for six months.' },
      { label: 'Restore behavior', value: 'Open in place', hint: 'Recovered threads reappear in their original section.' },
      { label: 'Artifact links', value: 'Preserved', hint: 'Archived threads keep bridge traces and attachments intact.' },
      { label: 'Compaction mode', value: 'Metadata only after archive', hint: 'Reduces token cost while keeping context discoverable.' },
    ],
  },
];
