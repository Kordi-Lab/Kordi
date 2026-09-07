import type {
  Contact,
  UpsertCanonicalIdentityRequest
} from '@/kordi-app/types';
import type { CloudAccount } from "./authClient";
import {
  cloudGroupIdentityRequest,
  cloudGroupParticipantFromContact,
  cloudGroupSelfParticipant
} from "./cloudGroupMessages";

export function cloudContactsToCanonicalIdentityRequests({
  account,
  contacts,
  localHumanIdentityId,
}: {
  account: CloudAccount;
  contacts: Contact[];
  localHumanIdentityId: string;
}): UpsertCanonicalIdentityRequest[] {
  const participants = [
    cloudGroupSelfParticipant(account, 'self'),
    ...contacts
      .map((contact) => cloudGroupParticipantFromContact(contact, 'person'))
      .filter((participant): participant is NonNullable<typeof participant> => Boolean(participant)),
  ];
  const seen = new Set<string>();
  const requests: UpsertCanonicalIdentityRequest[] = [];
  for (const participant of participants) {
    if (seen.has(participant.accountId)) continue;
    seen.add(participant.accountId);
    requests.push(cloudGroupIdentityRequest(participant, account, localHumanIdentityId));
  }
  return requests;
}
