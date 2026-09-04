import { formatDesktopClockTime } from '@/lib/time';

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
  'Tab — accept slash command or @ selection',
  'Esc — close slash command or @ menu',
  '⌘/Ctrl+. — open settings',
].join('\n');

const CLOUD_SLASH_HELP_LINES = [
  'Available commands:',
  '',
  '/name      Rename current session',
  '/session   Show session info tab',
  '/new       Start a new session',
  '/reload    Refresh runtime-backed desktop state',
  '/skill     Manage loaded skills',
  '',
  'Type @ to add a reference or mention a contact or agent.',
].join('\n');

const CLOUD_HIDDEN_LOCAL_SLASH_COMMANDS = new Set(['/fork', '/tree']);

export function isSharedLocalSlashCommand(command: string) {
  if (CLOUD_HIDDEN_LOCAL_SLASH_COMMANDS.has(command)) return false;
  return SHARED_LOCAL_SLASH_COMMANDS.has(command);
}

export function desktopHotkeyHelpText() {
  return DESKTOP_HOTKEY_LINES;
}

export function desktopSlashHelpText() {
  return CLOUD_SLASH_HELP_LINES;
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
    case 'max':
    case 'maximum':
      return 'Max';
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

export const CHAT_COMPOSER_TEXTAREA_SELECTOR = '[data-composer-scope="chat"]';

export function focusComposerTextarea(selector: string) {
  window.requestAnimationFrame(() => {
    const input = document.querySelector(selector) as HTMLElement | null;
    input?.focus();
  });
}

type NativeComposerFocusDeps = {
  focusNativeWindow?: () => void | Promise<void>;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  querySelector?: (selector: string) => Element | null | { focus?: () => void };
};

async function focusCurrentNativeWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setFocus();
}

export function focusComposerTextareaForNativeInput(
  selector: string,
  isNativeShell: boolean,
  deps: NativeComposerFocusDeps = {},
) {
  const requestAnimationFrame = deps.requestAnimationFrame ?? window.requestAnimationFrame.bind(window);
  const querySelector = deps.querySelector ?? document.querySelector.bind(document);
  const focusTextarea = () => {
    const textarea = querySelector(selector) as (HTMLTextAreaElement | { focus?: () => void } | null);
    textarea?.focus?.();
  };

  if (!isNativeShell) {
    requestAnimationFrame(() => focusTextarea());
    return;
  }

  void Promise.resolve(deps.focusNativeWindow ? deps.focusNativeWindow() : focusCurrentNativeWindow())
    .catch(() => undefined)
    .finally(() => {
      requestAnimationFrame(() => focusTextarea());
    });
}

export function resizeComposerTextarea(selector: string, value?: string) {
  window.requestAnimationFrame(() => {
    const input = document.querySelector(selector) as HTMLElement | null;
    if (!input) return;
    if (input.tagName === 'TEXTAREA' || 'value' in input) {
      const textarea = input as HTMLTextAreaElement;
      textarea.value = value ?? '';
      textarea.style.height = '0px';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    }
    if (typeof value === 'string') {
      input.focus();
      if ('setSelectionRange' in input) {
        (input as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  });
}
