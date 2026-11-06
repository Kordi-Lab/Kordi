import './previewChatTheme';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleHelp, Plus } from 'lucide-react';
import HelpMenu from '../../src/features/onboarding/HelpMenu';
import { ChatCreateDialog, type ChatCreateMode, type ChatCreatePopoverAnchor } from '../../src/pages/ChatCreateDialog';
import type { Agent, Contact } from '../../src/kordi-app/types';

// Synthetic data only: the Start a chat menu beside the Help menu it mirrors.
// ?theme=light|dark, ?show=both|create|help, ?mode=menu|person|agent|group|add-contact, ?macDownload=1
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const show = params.get('show') ?? 'both';
const initialMode = (params.get('mode') ?? 'menu') as ChatCreateMode;
const macDownload = params.has('macDownload');
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

const contacts: Contact[] = ['Maya Chen', 'Ethan Park', 'Priya Shah'].map((name, index) => ({
  id: `preview-person-${index}`, name, initials: name.split(' ').map((part) => part[0]).join(''),
  classType: 'other-users', entityType: 'Person', subtitle: 'Kordi contact', collaborationSources: ['Cloud'],
  status: 'Online', discoverableOn: [], detail: '', owner: name, avatarSeed: name, profileImageUrl: null,
}));
const agents: Agent[] = [{
  id: 'agent:preview', name: 'Kordi', role: 'Coding partner', messaging: 'Available', status: 'Ready', tasks: 0,
  defaultProvider: 'openai', defaultModel: 'preview-model', collaborationConfig: 'Cloud', contactId: 'contact:preview-agent',
  systemPrompt: '', xMd: '', identityFiles: [], loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: [],
  avatarSeed: 'preview-agent', profileImageUrl: null,
}];

function anchorOf(element: HTMLElement): ChatCreatePopoverAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function Fixture() {
  const plus = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLButtonElement>(null);
  const [createAnchor, setCreateAnchor] = useState<ChatCreatePopoverAnchor | null>(null);
  const [helpAnchor, setHelpAnchor] = useState<ChatCreatePopoverAnchor | null>(null);
  const [started, setStarted] = useState('');
  const openCreate = (event: MouseEvent<HTMLButtonElement>) => setCreateAnchor(anchorOf(event.currentTarget));
  const openHelp = (event: MouseEvent<HTMLButtonElement>) => setHelpAnchor(anchorOf(event.currentTarget));
  useEffect(() => {
    // ?show=both opens the two menus together for side-by-side review.
    if (show === 'both' || show === 'help') setHelpAnchor(anchorOf(help.current!));
    if (show === 'both' || show === 'create') setCreateAnchor(anchorOf(plus.current!));
  }, []);
  return <div className={`kordi-app theme-${theme} app-cloud-workspace-surface`} style={{ display: 'flex', height: '100dvh', background: 'var(--app-page-bg)', color: 'var(--utility-foreground)' }}>
    <nav style={{ width: 52, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', padding: '12px 0' }}>
      <button ref={help} aria-label="Help & setup" onClick={openHelp} style={{ width: 32, height: 32, display: 'grid', placeItems: 'center' }}><CircleHelp size={16} /></button>
    </nav>
    <aside className="app-side-shell" style={{ width: 260, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 12px' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Chats</span>
        <button ref={plus} aria-label="Start a chat" onClick={openCreate} style={{ width: 28, height: 28, display: 'grid', placeItems: 'center' }}><Plus size={16} /></button>
      </div>
      {contacts.map((item) => <div key={item.id} style={{ padding: '14px 8px', fontSize: 13 }}>{item.name}</div>)}
    </aside>
    <main style={{ flex: 1, padding: 28, fontSize: 13, opacity: 0.6 }}>
      <p>Offline preview · Sample data</p>
      <p data-testid="started">{started}</p>
    </main>
    <ChatCreateDialog
      isOpen={Boolean(createAnchor)}
      anchorRect={createAnchor}
      initialMode={initialMode}
      contacts={contacts}
      addableContacts={[]}
      agents={agents}
      onClose={() => setCreateAnchor(null)}
      onStartPerson={(contact) => setStarted(`person:${contact.name}`)}
      onStartAgent={(agent) => setStarted(`agent:${agent.name}`)}
      onCreateGroup={() => setStarted('group')}
      onAddContact={() => setStarted('add-contact')}
    />
    {helpAnchor ? <HelpMenu anchor={helpAnchor} progressKey="start-chat-preview" settingsAvailable supportAvailable onAction={() => {}} onOpenSession={() => {}} onStartTour={() => {}} onDismiss={() => setHelpAnchor(null)} onMacDownload={macDownload ? () => setStarted('mac-download') : undefined} /> : null}
  </div>;
}

createRoot(document.querySelector('#root')!).render(<Fixture />);
