import './previewChatTheme';
import { createRoot } from 'react-dom/client';
import DigestPage from '../../src/features/digest/DigestPage';
import { digestClient } from '../../src/features/digest/client';
import type { CalendarEvent, DigestItem, DigestResponse } from '../../src/features/digest/types';
import '../../src/index.css';

// Login-free preview of the Digest page with a stubbed client, for spacing and alignment checks.
// Query: ?theme=light|dark, ?filled (synthetic brief and next steps), ?width=<px> (panel width, default 460).
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const width = Number(params.get('width')) || 460;
document.documentElement.classList.add('kordi-native-shell');
document.body.classList.add('kordi-native-shell', `theme-${theme}`);
document.documentElement.style.colorScheme = theme;

const now = new Date();
const at = (hours: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours).toISOString();
const item = (id: string, title: string, text: string): DigestItem => ({ id, title, text, kind: 'note', sourceIds: ['source'] });
const filled = params.has('filled');
const digest: DigestResponse = {
  accountId: 'preview', status: 'ready', revision: 1, partial: false, feedback: [],
  updatedAt: new Date(now.getTime() - 3 * 3_600_000).toISOString(),
  sources: [{ id: 'source', conversationId: 'conversation', sessionId: 'session', sessionTitle: 'Design review', senderAccountId: 'alex', senderName: 'Alex', text: 'Can we review the navigation draft tomorrow?', createdAt: at(9), version: 1 }],
  snapshot: {
    claims: filled ? [item('brief-1', 'Navigation draft is ready for review', 'Alex shared the second navigation draft and asked for feedback before the design review.'), item('brief-2', 'Launch checklist moved to Thursday', 'The team agreed to finish the checklist after the copy pass.')] : [],
    commitments: [],
    suggestions: filled ? [item('next-1', 'Send feedback on the navigation draft', 'Alex is waiting on comments before tomorrow.')] : [],
    calendarCandidates: [],
  },
};
const events: CalendarEvent[] = [{ id: 'review', title: 'Design review', startAt: at(10), endAt: at(11), allDay: false, sourceIds: [], description: '', revision: 1 }];
Object.assign(digestClient, {
  read: async () => structuredClone(digest),
  calendar: async () => ({ events: structuredClone(events) }),
  refresh: async () => {},
  feedback: async () => {},
});

createRoot(document.getElementById('root')!).render(
  <div className={`kordi-app theme-${theme} flex h-screen w-screen`} style={{ background: 'var(--app-main-bg)', color: 'var(--utility-foreground)' }}>
    <div style={{ flex: 1, borderRight: '1px solid var(--app-divider)' }} />
    <div data-testid="digest-panel" style={{ width, height: '100%', display: 'flex' }}><DigestPage accountId="preview" /></div>
  </div>,
);
