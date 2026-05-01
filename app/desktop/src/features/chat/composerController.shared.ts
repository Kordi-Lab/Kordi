import type { DesktopChatSlashCommand } from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';

const DESKTOP_STATIC_SLASH_COMMANDS = new Set([
  '/compact',
  '/fork',
  '/tree',
  '/export',
  '/import',
  '/reload',
  '/install',
  '/skill',
]);

const DESKTOP_EXCLUDED_SLASH_COMMANDS = new Set([
  '/help',
  '/hotkeys',
  '/settings',
  '/login',
  '/logout',
  '/model',
  '/new',
  '/resume',
  '/name',
  '/session',
  '/copy',
  '/quit',
  '/exit',
  '/image',
  '/update',
]);

const DESKTOP_HOTKEY_LINES = [
  'Desktop shortcuts',
  '',
  'Enter — send message',
  'Shift+Enter — newline',
  '↑/↓ — navigate slash commands',
  'Tab — accept slash command or @ mention',
  'Esc — close slash command or @ mention menu',
  '⌘/Ctrl+. — open settings',
].join('\n');

const DESKTOP_SLASH_HELP_LINES = [
  'Available desktop chat commands:',
  '',
  '/compact [instructions]       Compact the current session context',
  '/fork                         Fork from a previous message (coming soon)',
  '/tree                         Browse session branches (coming soon)',
  '/export [path]                Export the current session',
  '/import <path>                Import a session JSONL file when supported',
  '/reload                       Reload runtime resources and command catalog',
  '/install [-l|--local] <src>   Install a package source and reload resources',
  '/skill [list|disable|enable]  Manage loaded skills',
  '',
  'Type @ to reach out to visible bridge people or agents from chat/project composers.',
  'Skill, prompt, and extension slash commands also appear in the command menu.',
].join('\n');

function desktopSlashCommandToken(value: string) {
  return value.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

export function desktopSlashCommandIsExcluded(command: string) {
  return DESKTOP_EXCLUDED_SLASH_COMMANDS.has(desktopSlashCommandToken(command));
}

export function isSharedLocalSlashCommand(command: string) {
  return DESKTOP_STATIC_SLASH_COMMANDS.has(desktopSlashCommandToken(command));
}

export function filterDesktopSlashCommands(items: DesktopChatSlashCommand[]) {
  return items.filter((item) => !desktopSlashCommandIsExcluded(item.value));
}

export function isDesktopHandledSlashCommand(command: string, catalog: DesktopChatSlashCommand[] = []) {
  const token = desktopSlashCommandToken(command);
  if (!token || desktopSlashCommandIsExcluded(token)) return false;
  if (DESKTOP_STATIC_SLASH_COMMANDS.has(token)) return true;
  return catalog.some((item) => desktopSlashCommandToken(item.value) === token && !desktopSlashCommandIsExcluded(item.value));
}

export function desktopHotkeyHelpText() {
  return DESKTOP_HOTKEY_LINES;
}

export function desktopSlashHelpText() {
  return DESKTOP_SLASH_HELP_LINES;
}

export function formatDesktopEventTime() {
  return formatDesktopClockTime(new Date());
}

export function formatThinkingSelectionLabel(value: string) {
  switch (value.trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'off':
      return 'Off';
    case 'default':
    case 'auto':
    case 'thinking':
      return 'Default';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
    case 'extrahigh':
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
