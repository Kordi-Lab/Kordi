import type { CgProfile } from './types';

/** Suggestions describe meeting activities; no activity is selected without a choice. */
export function nearbyActivitySuggestions(profile?: Pick<CgProfile, 'kind' | 'icon'>): readonly string[] {
  if (profile?.icon === 'camera') return ['Photo walk', 'Sharing tips', 'Creative project', 'Coffee chat'];
  if (profile?.icon === 'graduation') return ['Alumni meetup', 'Mentoring', 'Career chat', 'Reconnecting'];
  if (profile?.kind === 'health' || profile?.icon === 'leaf') return ['Activity partner', 'Training together', 'Sharing tips', 'Encouragement'];
  if (profile?.kind === 'work') return ['Coffee chat', 'Collaborating', 'Advice', 'Hiring'];
  if (profile?.kind === 'daily') return ['Shared activity', 'Exploring together', 'Sharing tips', 'Coffee chat'];
  return ['Shared activity', 'Sharing ideas', 'Advice', 'Coffee chat'];
}
