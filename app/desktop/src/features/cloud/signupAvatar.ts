export const SIGNUP_AVATAR_PALETTES = [
  { from: '#f97316', to: '#ec4899', foreground: '#fff7ed' },
  { from: '#06b6d4', to: '#8b5cf6', foreground: '#f8fafc' },
  { from: '#14b8a6', to: '#84cc16', foreground: '#ecfeff' },
  { from: '#f59e0b', to: '#ef4444', foreground: '#fff7ed' },
  { from: '#6366f1', to: '#a855f7', foreground: '#f5f3ff' },
];

export function cloudSignupAvatarHashText(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function cloudSignupAvatarInitials(displayName: string | null | undefined) {
  const compact = Array.from(displayName?.trim().replace(/\s+/g, '') || '').filter((char) => /[\p{L}\p{N}]/u.test(char));
  return compact.slice(0, 2).join('').toLocaleUpperCase() || 'KO';
}

export function cloudSignupAvatarPalette(displayName: string | null | undefined) {
  const key = displayName?.trim() || 'kordi-cloud-signup';
  return SIGNUP_AVATAR_PALETTES[cloudSignupAvatarHashText(key) % SIGNUP_AVATAR_PALETTES.length] ?? SIGNUP_AVATAR_PALETTES[0];
}

export function cloudSignupAvatarBackground(palette: (typeof SIGNUP_AVATAR_PALETTES)[number]) {
  return `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`;
}
