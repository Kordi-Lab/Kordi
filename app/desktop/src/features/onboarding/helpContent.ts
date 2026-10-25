import type { NavId } from '@/kordi-app/types';
import type { CloudAccountSettingsTabId } from '@/pages/cloudAccountSettingsNav';

export type HelpAction =
  | { kind: 'navigate'; page: NavId }
  | { kind: 'settings'; tab: CloudAccountSettingsTabId }
  | { kind: 'grounding' | 'support' | 'updates' | 'permissions' };

export type HelpTopic = {
  id: string;
  title: string;
  summary: string;
  location: string;
  keywords: string;
  steps: readonly string[];
  action: HelpAction;
  actionLabel: string;
  requirement?: 'grounding' | 'connectors' | 'memory';
};

export const helpTopics: readonly HelpTopic[] = [
  {
    id: 'auth', title: 'Set up authentication', summary: 'Connect the accounts and models your agents use.',
    location: 'Profile → Settings → Authentication', keywords: 'config configure login oauth api key custom endpoint ollama lm studio provider model',
    steps: [
      'Your Kordi account signs you into the app. AI provider accounts are configured separately in Authentication.',
      'Choose a provider, then Add account. Use an available browser sign-in, device code, or API key method. Custom API accepts an OpenAI-compatible endpoint; local providers have their own setup controls.',
      'Choose the provider, saved account, and model in Test route. A connected account still needs a usable model before an agent can respond.',
      'Use the provider and model controls in an agent conversation to choose how it runs. If access expires, return here to reconnect.',
    ], action: { kind: 'settings', tab: 'auth' }, actionLabel: 'Open authentication',
  },
  {
    id: 'cards', title: 'Build and manage your cards', summary: 'Choose what a card says about you and what it draws from.',
    location: 'Contacts → Grounding', keywords: 'profile wallet work health daily research sources documents notes build rebuild privacy sharing', requirement: 'grounding',
    steps: [
      'Open Grounding in Contacts. Choose a card in your wallet or create a new one with a name, focus, and appearance.',
      'Open Build and select the sources you want to use: available memory, documents, connected services, device sources, links, or your own notes. You can start with notes without granting device access.',
      'Build the card, then review its topics and sources. Edit or remove topics, hide topics you do not want to share, and adjust the card appearance.',
      'Review the sharing control before pairing or joining a room. Choose the profile you want to share. Source access, inclusion in a build, and sharing are separate choices.',
      'Rebuild when your information changes. Review the result again before sharing; deleting a card also removes its associated matches and rooms.',
    ], action: { kind: 'grounding' }, actionLabel: 'Open cards in Grounding',
  },
  {
    id: 'social', title: 'Meet people through Grounding', summary: 'Pair, discover shared interests, and turn a connection into a conversation.',
    location: 'Contacts → Grounding', keywords: 'social match meet qr code pair room common ground share invite', requirement: 'grounding',
    steps: [
      'Build and review a card first. Enable sharing for the profile you want the other person to see.',
      'Use Pair to show your QR code or temporary code, or enter the other person’s code. Create or join a room when that option is available.',
      'Open a person or match to explore shared interests and what each of you can offer. A match is a starting point for discussion.',
      'Add the person as a contact or accept their request. Use Chat to talk, or Meet to propose a meeting. Review recipients and details before sending.',
    ], action: { kind: 'grounding' }, actionLabel: 'Open Grounding',
  },
  {
    id: 'contacts', title: 'Contacts and invitations', summary: 'Find someone, accept a request, or invite them to Kordi.',
    location: 'Contacts · Chats → + · Profile', keywords: 'social friend people kordi id add request invite group',
    steps: [
      'Open Contacts to find people and review incoming requests. Open a profile to see the available contact actions.',
      'Use + in Chats and Add contact to look up a Kordi ID. Check the profile before sending the request.',
      'Open your profile to copy your Kordi ID or personal invitation link. Share the link with the person you want to invite.',
      'For a group invitation, open the group’s details and its invitation controls. Group roles determine which management actions you can use.',
    ], action: { kind: 'navigate', page: 'contacts' }, actionLabel: 'Open contacts',
  },
  {
    id: 'chats', title: 'Chats, groups, and channels', summary: 'Talk to people and keep shared conversations organized.',
    location: 'Chats', keywords: 'message group channel search reply thread pin archive mute unread forward delete project',
    steps: [
      'Use + in Chats to start a conversation or create a group. Open a group to find its conversations and channels.',
      'Write in the composer. Use message actions to reply, react, forward, or pin; discussions keep a focused thread beside the main conversation.',
      'Use search to find contacts, groups, and sessions. Conversation menus include pin, mute, unread, archive, and delete actions where available.',
      'Open group details to manage its name, members, invitations, and roles. Review a delete confirmation carefully; archiving is useful when you only want to tidy the list.',
    ], action: { kind: 'navigate', page: 'chats' }, actionLabel: 'Open chats',
  },
  {
    id: 'media', title: 'Files, voice, video, and calls', summary: 'Share more than text and recover when device access is blocked.',
    location: 'Chat composer and conversation header', keywords: 'attachment photo emoji microphone camera speech recording audio video call permission',
    steps: [
      'Open a conversation and use its attachment or media controls. Review selected files and recordings before sending.',
      'Voice recording and audio calls need microphone access. Video recording and video calls also need camera access. Speech recognition has a separate permission.',
      'Use the call controls available for that conversation. During a call, choose your input/output devices and control mute or camera access.',
      'If access is blocked, open Permissions & access here. Allow the specific permission or open System Settings, then return to Kordi and try again.',
    ], action: { kind: 'permissions' }, actionLabel: 'Review permissions',
  },
  {
    id: 'agents', title: 'Agent conversations', summary: 'Choose an agent, a model, and the context for your task.',
    location: 'Agent Chats', keywords: 'ai provider model prompt task workspace folder background approval',
    steps: [
      'Open Agent Chats and use + to choose an agent. Configure Authentication if no usable provider is available.',
      'Check the selected provider and model. Add the files or context needed for your request, then send it.',
      'Review the agent’s response and any pending action request. Permissions & access helps you locate requests waiting for a decision.',
      'Use the conversation’s Tasks, Artifacts, and Memory destinations when available to inspect its work and context.',
    ], action: { kind: 'navigate', page: 'agent-chats' }, actionLabel: 'Open agent chats',
  },
  {
    id: 'factory', title: 'Configure agents in Factory', summary: 'Create and refine agents, skills, and tools.',
    location: 'Factory', keywords: 'agent builder identity instructions prompt skills tools library configure',
    steps: [
      'Open Factory to browse your agents and the available library sections.',
      'Select an agent to inspect its instructions and configuration, or use the creation controls to build one for a task.',
      'Review its model/provider choices and available skills and tools. Grant connected-service access in Connectors when needed.',
      'Try the agent in a conversation and refine its instructions based on the result.',
    ], action: { kind: 'navigate', page: 'agents' }, actionLabel: 'Open Factory',
  },
  {
    id: 'connectors', title: 'Connect services and manage agent access', summary: 'Bring connected accounts into Kordi with explicit access controls.',
    location: 'Profile → Settings → Connectors', keywords: 'gmail google calendar github slack outlook automation contacts full disk read act grant revoke oauth', requirement: 'connectors',
    steps: [
      'Choose an available service and connect the intended account. Review the requested access before continuing.',
      'Inspect Allowed access and select which agents may use the connection. Reading and acting are separate permissions.',
      'Use Let my agent act here only when you want actions enabled. Requests covered by Ask me before still wait for your decision.',
      'Review the activity log, reconnect expired accounts, or disconnect a service. Mac sources may also require access in System Settings.',
    ], action: { kind: 'settings', tab: 'connectors' }, actionLabel: 'Open connectors',
  },
  {
    id: 'documents', title: 'Documents, artifacts, and tasks', summary: 'Find the work attached to a conversation and collaborate on it.',
    location: 'Conversation → Artifacts / Tasks', keywords: 'file markdown html edit shared document comment live collaboration plan card calendar',
    steps: [
      'Open a conversation and choose Artifacts to inspect its files and supported documents.',
      'Open a supported document beside the chat to read or edit it. Use its sharing and comment controls when available.',
      'Review who can access a document before sharing a link. Comment mentions can involve an agent in the document’s context.',
      'Use Tasks for conversation activity and review plan cards before confirming changes or adding an event.',
    ], action: { kind: 'navigate', page: 'chats' }, actionLabel: 'Open conversations',
  },
  {
    id: 'memory', title: 'Review and manage memory', summary: 'See what Kordi remembers and control what stays.',
    location: 'Profile → Settings → Memory', keywords: 'remember forget lessons privacy delete edit card group', requirement: 'memory',
    steps: [
      'Open Memory settings to review account memory. Available controls let you add, edit, delete, or switch off memory.',
      'Use a conversation’s Memory destination for its available shared context.',
      'In Grounding, choose whether memory contributes to a card. Review the resulting topics and sharing choices separately.',
    ], action: { kind: 'settings', tab: 'memory' }, actionLabel: 'Open memory',
  },
  {
    id: 'digest', title: 'Digest and calendar', summary: 'Catch up on activity and review plans in one place.',
    location: 'Digest', keywords: 'summary daily schedule event calendar sync import ics reminder task',
    steps: [
      'Open Digest to review available summaries and calendar items. Open its settings to adjust the available sources and preferences.',
      'Review suggested events and changes before applying them. Check the time, participants, and destination calendar.',
      'Use Calendar settings to manage device access and synchronization. Import ICS when you want to bring in calendar events from a file or link.',
      'If a source is unavailable, reconnect it in Connectors or review calendar permission in Permissions & access.',
    ], action: { kind: 'navigate', page: 'digest' }, actionLabel: 'Open Digest',
  },
  {
    id: 'preferences', title: 'Your account and preferences', summary: 'Manage your profile, signed-in devices, notifications, and appearance.',
    location: 'Profile → Settings', keywords: 'account sessions devices logout avatar name theme light dark threads notification sound badge',
    steps: [
      'Open your profile, then Settings to update your profile details.',
      'Review Active sessions to manage signed-in devices.',
      'Use Notifications for alerts, sound, previews, and Dock preferences. System notification permission is a separate control.',
      'Use Appearance to adjust the theme and available message-layout options.',
    ], action: { kind: 'settings', tab: 'profile' }, actionLabel: 'Open account settings',
  },
  {
    id: 'support', title: 'Get support and find updates', summary: 'Ask a question, report an issue, or revisit release highlights.',
    location: 'Kordi Support · Help & setup', keywords: 'help problem bug feedback report release whats new update',
    steps: [
      'Open Kordi Support to ask a question or suggest an improvement.',
      'For a report, describe what happened and review the submission. Diagnostics are optional and sending requires your confirmation.',
      'Use What’s New in this hub to revisit release highlights. The update control in the navigation rail handles app updates.',
    ], action: { kind: 'support' }, actionLabel: 'Open Kordi Support',
  },
];

export function searchHelpTopics(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return helpTopics.filter((topic) => words.every((word) =>
    `${topic.title} ${topic.summary} ${topic.location} ${topic.keywords} ${topic.steps.join(' ')}`.toLowerCase().includes(word)));
}

export function contextualHelpTopic(nav: NavId): string {
  return ({ chats: 'chats', 'agent-chats': 'agents', contacts: 'contacts', agents: 'factory', digest: 'digest' } as Partial<Record<NavId, string>>)[nav] ?? 'preferences';
}

export const introduction = [
  { topic: 'auth', title: 'Make Kordi yours', body: 'Your profile is your Kordi identity. Authentication connects the AI accounts and models your agents use.' },
  { topic: 'cards', title: 'Choose what you share', body: 'Cards in Grounding describe your interests and work. Choose sources, review topics, and control sharing before meeting people.' },
  { topic: 'social', title: 'Find your people', body: 'Contacts and Grounding help you connect through invitations, pairing, rooms, and common interests.' },
  { topic: 'chats', title: 'Talk and work together', body: 'Chats brings people and groups together. Agent Chats and Factory are where you work with and configure AI agents.' },
  { topic: 'digest', title: 'Keep track and stay in control', body: 'Find work in documents, tasks, memory, and Digest. Return to ? anytime for setup, permissions, and help with the current screen.' },
] as const;
