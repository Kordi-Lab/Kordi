import type { NavId } from '@/kordi-app/types';

export type HelpTourStep = {
  target: string;
  title: string;
  body: string;
  page?: NavId;
};

export const helpTourSteps: readonly HelpTourStep[] = [
  { target: 'settings-auth', title: 'Connect your AI accounts', body: 'Authentication is where you connect providers or add an API key. Your connected accounts make models available to your agents.' },
  { target: 'grounding', page: 'contacts', title: 'Start with your cards', body: 'Open Grounding to build a card from the sources you choose. Review its topics and sharing before using it to meet people.' },
  { target: 'nav-contacts', page: 'contacts', title: 'Find your people', body: 'Contacts keeps people and invitations together. Grounding adds pairing, rooms, and shared interests to help you make new connections.' },
  { target: 'nav-chats', page: 'chats', title: 'Keep conversations together', body: 'Chats is for people, groups, and channels. Use + to start a conversation, then share messages, files, voice, or a call.' },
  { target: 'nav-agents', page: 'agents', title: 'Make an agent your own', body: 'Factory is where you configure agents, skills, and tools. When you’re ready to work with an agent, open Agent Chats in this same rail.' },
  { target: 'nav-digest', page: 'digest', title: 'Catch up and plan ahead', body: 'Digest brings activity and calendar items together. Documents, tasks, and artifacts stay with the conversations where you work on them.' },
  { target: 'help', title: 'Help is always right here', body: 'Use ? to replay this tour or open Permissions & access to allow a device feature or recover blocked access.' },
];
