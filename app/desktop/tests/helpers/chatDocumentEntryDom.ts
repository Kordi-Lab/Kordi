import assert from 'node:assert/strict';
import { act } from 'react';

import type { AttachmentItem } from '../../src/features/chat/composerController.types';
import type { DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import type { Message, MessageAttachment } from '../../src/kordi-app/types';

/** Fixtures and DOM steps shared by the chat document entry tests. */
export const STORED_PATH = '/tmp/kordi-attachments/Plan-1.md';
export const DOCUMENT_BODY = '# Plan\n';
// Where the upload persists its copy; sent messages point here, not at the stored file.
export const CACHED_COPY_PATH = '/tmp/kordi-cloud-attachments/att_new/Plan.md';
export const conversation = { id: 'session:group:example', canonicalSessionId: 'session:group:example', canonicalParticipants: [] };

export function attachmentMessage(id: string, attachment: Partial<MessageAttachment> & { name: string }): Message {
  return { id, role: 'user', isOwnMessage: true, text: '', time: '10:02', attachments: [{ kind: 'file', ...attachment }] };
}

export function storedItem(file: File): AttachmentItem {
  return { id: `${file.name}-${STORED_PATH}`, name: file.name, path: STORED_PATH, localPath: STORED_PATH, kind: 'file', mimeType: file.type, sizeBytes: file.size };
}

export function hostWith(addDocument?: DocumentReaderHost['addDocument']): DocumentReaderHost {
  return { viewer: null, sessionId: conversation.id, agentName: null, people: [], opensDocumentsInCompanion: true, addDocument };
}

export function button(root: ParentNode, label: string) {
  const match = Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
  assert.ok(match, `button ${label}`);
  return match;
}

/** React loaded before the window, so it watches text fields through the old IE input events. */
export function shimLegacyInputEvents() {
  Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
}

export async function click(element: HTMLElement) {
  shimLegacyInputEvents();
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function nameField(root: ParentNode) {
  return root.querySelector('input[aria-label="Document name"]') as HTMLInputElement | null;
}

export async function typeName(root: ParentNode, value: string) {
  const field = nameField(root);
  assert.ok(field, 'the name field is open');
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    // The old IE input events read the change on keyup.
    field.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Enter in the name field: the form submits, as the browser does for a text field. */
export async function pressEnter(root: ParentNode) {
  const form = nameField(root)?.form;
  assert.ok(form);
  await act(async () => {
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function pressEscape(root: ParentNode) {
  const field = nameField(root);
  assert.ok(field);
  await act(async () => {
    field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** New document, a typed name, then Create. */
export async function createNamed(root: ParentNode, name: string) {
  await click(button(root, 'New document'));
  await typeName(root, name);
  await click(button(root, 'Create'));
}
