import type { CgRelationship } from './types';

/** The contact action a person row or match shows. `hidden` when the server cannot do it. */
export type CgContactAction = 'add' | 'requested' | 'accept' | 'message' | 'hidden';

export function contactActionFor(relationship: CgRelationship | null | undefined, canAdd: boolean): CgContactAction {
  if (!relationship) return 'hidden';
  if (relationship.contact) return 'message';
  if (relationship.request === 'incoming') return relationship.requestId ? 'accept' : 'requested';
  if (relationship.request === 'outgoing') return 'requested';
  return canAdd ? 'add' : 'hidden';
}

/** Meet needs both people to be contacts first. */
export function canMeet(relationship: CgRelationship | null | undefined): boolean {
  return relationship?.contact === true;
}

export const CONTACT_ACTION_LABELS: Record<Exclude<CgContactAction, 'hidden'>, string> = {
  add: 'Add',
  requested: 'Requested',
  accept: 'Accept',
  message: 'Message',
};
