import { CalendarDays, GitPullRequest, Mail, MessageSquare, Plug, type LucideIcon } from 'lucide-react';

export type MessageEventSourceProvider = { name: string; icon: LucideIcon };

// A Map, so provider ids such as `constructor` or `__proto__` never match inherited members.
const PROVIDERS = new Map<string, MessageEventSourceProvider>([
  ['gmail', { name: 'Gmail', icon: Mail }],
  ['google_calendar', { name: 'Calendar', icon: CalendarDays }],
  ['calendar', { name: 'Calendar', icon: CalendarDays }],
  ['gcal', { name: 'Calendar', icon: CalendarDays }],
  ['github', { name: 'GitHub', icon: GitPullRequest }],
  ['slack', { name: 'Slack', icon: MessageSquare }],
]);

/** The display name and icon of a connector provider; unknown providers show their capitalized id. */
export function messageEventSourceProvider(provider: string): MessageEventSourceProvider {
  const key = provider.trim().toLowerCase();
  const known = PROVIDERS.get(key) ?? PROVIDERS.get(key.replace(/[\s-]+/g, '_'));
  if (known) return known;
  const words = key.replace(/[_-]+/g, ' ').trim();
  return { name: words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Source', icon: Plug };
}
