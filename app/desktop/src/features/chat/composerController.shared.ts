const SHARED_LOCAL_SLASH_COMMANDS = new Set([
  '/settings',
  '/model',
  '/export',
  '/import',
  '/copy',
  '/name',
  '/session',
  '/hotkeys',
  '/fork',
  '/tree',
  '/login',
  '/logout',
  '/new',
  '/compact',
  '/resume',
  '/reload',
  '/install',
  '/skill',
  '/update',
  '/image',
  '/help',
  '/quit',
  '/exit',
]);

const DESKTOP_HOTKEY_LINES = [
  'Desktop shortcuts',
  '',
  'Enter — send message',
  'Shift+Enter — newline',
  '↑/↓ — navigate slash commands',
  'Tab — accept slash command',
  'Esc — close slash command menu',
  '⌘/Ctrl+. — open settings',
].join('\n');

const DESKTOP_SLASH_HELP_LINES = [
  'Available commands:',
  '',
  '/name      Rename current session',
  '/session   Show session info tab',
  '/new       Start a new session',
  '/reload    Refresh runtime-backed desktop state',
  '/tree      Navigate session tree',
  '/fork      Fork from a previous message',
  '/skill     Manage loaded skills',
  '',
  'Skill, prompt, and extension slash commands also appear in the command menu.',
].join('\n');

export function isSharedLocalSlashCommand(command: string) {
  return SHARED_LOCAL_SLASH_COMMANDS.has(command);
}

export function desktopHotkeyHelpText() {
  return DESKTOP_HOTKEY_LINES;
}

export function desktopSlashHelpText() {
  return DESKTOP_SLASH_HELP_LINES;
}

export function formatDesktopEventTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatThinkingSelectionLabel(value: string) {
  switch (value) {
    case 'off':
      return 'Off';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    default:
      return value;
  }
}

export function parseModelSelection(value: string) {
  const [provider, ...modelParts] = value.split('/');
  return {
    provider: provider?.trim() || '',
    modelId: modelParts.join('/').trim() || value,
  };
}

export function resizeComposerTextarea(selector: string, value?: string) {
  window.requestAnimationFrame(() => {
    const textarea = document.querySelector(selector) as HTMLTextAreaElement | null;
    if (!textarea) return;
    if (typeof value === 'string') {
      textarea.value = value;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    if (typeof value === 'string') {
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    }
  });
}
