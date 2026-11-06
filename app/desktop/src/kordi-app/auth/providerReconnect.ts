import type { AuthDisplayProvider } from './model';

/** Saved accounts of this provider that need reconnecting. */
export function providerReconnectCount(provider: AuthDisplayProvider, needsReconnect: ReadonlySet<string>) {
  return provider.methods.reduce((count, method) => count
    + method.options.filter((option) => needsReconnect.has(option.value)).length, 0);
}

/** The reconnect status a provider row shows next to its summary, or null. */
export function providerReconnectLabel(count: number, total: number) {
  if (count <= 0) return null;
  if (count >= total) return count === 1 ? 'Needs reconnecting' : 'All need reconnecting';
  return `${count} need${count === 1 ? 's' : ''} reconnecting`;
}

export function providerAccountCount(provider: AuthDisplayProvider) {
  return provider.methods.reduce((count, method) => count + method.options.length, 0);
}
