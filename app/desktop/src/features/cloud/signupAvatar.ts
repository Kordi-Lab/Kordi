export const SIGNUP_AVATAR_PALETTES = [
  { from: '#6FCF97', to: '#6FCF97', foreground: '#1F2937' },
  { from: '#F2A65A', to: '#F2A65A', foreground: '#1F2937' },
  { from: '#E8A0C8', to: '#E8A0C8', foreground: '#1F2937' },
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
