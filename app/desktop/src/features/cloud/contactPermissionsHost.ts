// The cloud implementation of the contact permissions host, shared by the
// contact profile and the member popover of a shared conversation (which
// also reaches people who are not contacts).

import type { ContactPermissionsHost } from '@/kordi-app/contacts/contactProfileHost';
import { noteAgentAccess } from './agentRestrictions';
import { fetchContactPermissions, updateContactPermissions } from './contactPermissionsClient';
import type { FetchContactProfileOptions } from './contactProfileClient';

export function cloudContactPermissionsHost(request: FetchContactProfileOptions['request']): ContactPermissionsHost {
  return {
    load: (accountId, signal) => fetchContactPermissions(accountId, { signal, request }),
    save: async (accountId, patch) => {
      const saved = await updateContactPermissions(accountId, patch, { request });
      // This Mac applies the new rule to the next request at once.
      noteAgentAccess(saved.accountId, saved.agentAccess);
      return saved;
    },
  };
}
