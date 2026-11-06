export function shouldRefreshCloudContactsForWsSubject(subject: string | undefined | null): boolean {
  return Boolean(
    subject?.startsWith('kordi.events.contact.request.')
      || subject?.startsWith('kordi.events.contact.added.') || subject?.startsWith('kordi.events.contact.removed.')
      || subject?.startsWith('kordi.events.account.profile.updated.'),
  );
}
