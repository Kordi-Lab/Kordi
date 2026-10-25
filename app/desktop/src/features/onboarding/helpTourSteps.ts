import type { CloudAccountSettingsTabId } from '@/pages/cloudAccountSettingsNav';
import type { NavId } from '@/kordi-app/types';

export type HelpTourStep = {
  target: string;
  section?: string;
  title: string;
  body: string;
  page?: NavId;
  settings?: CloudAccountSettingsTabId;
  groundingScreen?: 'home' | 'build' | 'card';
};

const overviewSteps: readonly HelpTourStep[] = [
  { target: 'settings-auth', settings: 'auth', title: 'Connect an AI account', body: 'Choose a provider here, then sign in or add its API key. This lets your agents use that provider’s models.' },
  { target: 'grounding', page: 'contacts', title: 'Create a card about yourself', body: 'Click Grounding to create a card with your interests and what you want to work on. You choose what to share with other people.' },
  { target: 'nav-contacts', page: 'contacts', title: 'Add someone to your contacts', body: 'Open Contacts, then use the add-person button above the list to find or invite someone. Select a contact to see their profile and message them.' },
  { target: 'nav-chats', page: 'chats', title: 'Start a conversation', body: 'Open Chats, then click + to start a chat or group. Select a conversation to send a message or attach a file.' },
  { target: 'nav-agents', page: 'agents', title: 'Set up an agent', body: 'Open Factory to create or edit an agent. Choose its model, instructions, and tools. Then open Agent Chats to talk to it.' },
  { target: 'nav-digest', page: 'digest', title: 'Check your daily overview', body: 'Open Digest to review recent activity and upcoming calendar events.' },
  { target: 'help', title: 'Find help here anytime', body: 'Click ? to replay this tour. Choose Permissions & access to enable your microphone, camera, notifications, or calendar.' },
];


export type HelpTourId = 'workspace' | 'grounding' | 'cards' | 'imports';
export const helpTours: Record<HelpTourId, readonly HelpTourStep[]> = {
  workspace: overviewSteps,
  grounding: [
    { target: 'grounding', page: 'contacts', title: 'Meet people through Grounding', body: 'Grounding is in Contacts. Open it to find people with shared interests using the cards you choose to share.' },
    { target: 'grounding-cards', groundingScreen: 'home', title: 'Choose the card you want to share', body: 'Select a card for this conversation: work, interests, or a custom topic. Your other cards stay separate.' },
    { target: 'grounding-pair', groundingScreen: 'home', title: 'Pair with one person', body: 'Click Pair to show your code or enter theirs. Build the selected card first so there is something to compare.' },
    { target: 'grounding-room', groundingScreen: 'home', title: 'Join or create a room', body: 'Enter a four-digit room code, or click Create to start a room. Choose the card you share before joining.' },
  ],
  cards: [
    { target: 'grounding-cards', groundingScreen: 'home', title: 'Keep different sides of you in separate cards', body: 'Select a card here to work on it. Each card has its own topics, sources, and sharing settings.' },
    { target: 'grounding-new-card', groundingScreen: 'home', title: 'Add a card', body: 'Click New card to choose a type and give it a name. Creating a card does not automatically share it.' },
    { target: 'grounding-documents', groundingScreen: 'build', title: 'Choose documents for this card', body: 'Open this list to select Kordi documents. Only the documents you select are included in this build.' },
    { target: 'grounding-notes', groundingScreen: 'build', title: 'Add links and your own notes', body: 'Add websites or notes about what you do, what interests you, and what help you can offer. Review the other sources above before building.' },
    { target: 'grounding-build', groundingScreen: 'build', title: 'Build when your sources are ready', body: 'Click Build to turn your selected sources into card topics. After building, open the card to review its topics and choose whether to share it.' },
    { target: 'grounding-topics', groundingScreen: 'card', title: 'Review what your card says', body: 'Review the topics and their sources. Edit or hide anything you do not want on the card before sharing.' },
    { target: 'grounding-sharing', groundingScreen: 'card', title: 'Decide whether to share this card', body: 'Use Share my card to control sharing. Turn it on when you are ready to use this card in Grounding.' },
  ],
  imports: [
    { target: 'settings-memory', settings: 'memory', title: 'Bring your existing knowledge into Kordi', body: 'Open Memory in settings to import instructions and memories from your coding agents. Turn on Memory to show the Import section.' },
    { target: 'memory-import-files', settings: 'memory', title: 'Choose the files to import', body: 'Review the detected files or click Choose files to add your own. Select only the files you want Kordi to read.' },
    { target: 'memory-import-run', settings: 'memory', title: 'Import the selected files', body: 'Click Import when you are ready. Kordi extracts memories from the selected files; you can review and remove them in Memory.' },
    { target: 'memory-review', settings: 'memory', title: 'Review what was imported', body: 'Find the imported memories here. Search, edit, or remove anything you do not want Kordi to remember.' },
  ],
};

// One walkthrough, with short sections and direct entry points in Help.
const section = (name: string, steps: readonly HelpTourStep[]) => steps.map((step) => ({ ...step, section: name }));
export const helpTourSteps: readonly HelpTourStep[] = [
  ...section('Authentication', overviewSteps.slice(0, 1)),
  ...section('Cards', helpTours.cards),
  ...section('Grounding', helpTours.grounding.slice(2)),
  ...section('Contacts', overviewSteps.slice(2, 3)),
  ...section('Chat', overviewSteps.slice(3, 4)),
  ...section('Agents', overviewSteps.slice(4, 5)),
  ...section('Import memory', helpTours.imports),
  ...section('Digest', overviewSteps.slice(5, 6)),
  ...section('Help', overviewSteps.slice(6)),
];
helpTours.workspace = helpTourSteps;
export const helpTourEntry: Record<HelpTourId, string> = { workspace: 'settings-auth', cards: 'grounding-cards', grounding: 'grounding-pair', imports: 'settings-memory' };
