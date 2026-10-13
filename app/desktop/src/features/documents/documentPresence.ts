const PRESENCE_COLORS = ['#847ac4', '#2563eb', '#0f9f6e', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626'];

/** A stable color per account from the app palette, for carets and presence avatars. */
export function presenceColor(accountId: string) {
  let hash = 0;
  for (const character of accountId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/** Someone else in the document's collaboration room. */
export type DocumentPresencePeer = { clientId: number; name: string; color: string; accountId: string | null };

export type DocumentCollabState = { status: 'connecting' | 'connected' | 'offline'; peers: DocumentPresencePeer[] };
