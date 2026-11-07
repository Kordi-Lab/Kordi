import { setMessageLayout } from '../../src/app/messageLayoutPreference';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../../src/kordi-app/types';

// The compact shell group chat with one open-able discussion: a root message
// that mentions a member and a single reply. Synthetic data only.
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
localStorage.setItem('kordi.syntheticCompactInitialized.v1', '1');
localStorage.setItem('kordi.themeMode.v1', theme);
setMessageLayout('chat');

await import('./compactShell');
const state = (window as unknown as { syntheticPreviewState: CanonicalSessionState }).syntheticPreviewState;
const [self, , maya] = state.identities;
const sessionId = state.sessions[0].id;
const at = (minute: number) => { const date = new Date(); date.setHours(13, minute, 0, 0); return date.getTime(); };
const message = (id: string, sender: string, text: string, minute: number, content: object = {}): CanonicalSessionMessage => ({
  id, sessionId, senderIdentityId: sender, senderRole: sender === self.id ? 'user' : 'person', messageKind: 'text', contentText: text,
  content: { deliveryState: 'sent', ...content }, status: 'sent', sequenceNum: state.messages.length + 1, createdAtMs: at(minute), updatedAtMs: at(minute),
});
const rootText = '@Maya Chen can you check the discussion spacing?';
state.messages.push(message('synthetic-discussion-root', self.id, rootText, 18, {
  mentions: [{ identityId: maya.id, label: 'Maya Chen', start: 0, end: 10 }],
}));
state.messages.push(message('synthetic-discussion-reply', maya.id, 'Looks aligned now.', 19, {
  messageAction: { schemaVersion: 1, kind: 'thread', source: { sourceSessionId: sessionId, sourceMessageId: 'synthetic-discussion-root', senderLabel: self.displayName, textPreview: rootText, attachmentCount: 0 } },
}));
