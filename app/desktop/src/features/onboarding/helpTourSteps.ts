import type { NavId } from '@/kordi-app/types';

export type HelpTourStep = {
  target: string;
  title: string;
  body: string;
  page?: NavId;
};

export const helpTourSteps: readonly HelpTourStep[] = [
  { target: 'settings-auth', title: 'Connect an AI account', body: 'Choose a provider here, then sign in or add its API key. This lets your agents use that provider’s models.' },
  { target: 'grounding', page: 'contacts', title: 'Create a card about yourself', body: 'Click Grounding to create a card with your interests and what you want to work on. You choose what to share with other people.' },
  { target: 'nav-contacts', page: 'contacts', title: 'Add someone to your contacts', body: 'Open Contacts, then use the add-person button above the list to find or invite someone. Select a contact to see their profile and message them.' },
  { target: 'nav-chats', page: 'chats', title: 'Start a conversation', body: 'Open Chats, then click + to start a chat or group. Select a conversation to send a message or attach a file.' },
  { target: 'nav-agents', page: 'agents', title: 'Set up an agent', body: 'Open Factory to create or edit an agent. Choose its model, instructions, and tools. Then open Agent Chats to talk to it.' },
  { target: 'nav-digest', page: 'digest', title: 'Check your daily overview', body: 'Open Digest to review recent activity and upcoming calendar events.' },
  { target: 'help', title: 'Find help here anytime', body: 'Click ? to replay this tour. Choose Permissions & access to enable your microphone, camera, notifications, or calendar.' },
];
