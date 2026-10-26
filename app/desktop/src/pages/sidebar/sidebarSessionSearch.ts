/** Whether a sidebar session matches the chat search: its title, preview, space title or participant names. */
export function sidebarSessionMatchesSearch(
  { session, space }: {
    session: { title: string; preview: string };
    space: { title: string; participants: ReadonlyArray<{ name: string }> };
  },
  search: string,
) {
  const query = search.trim().toLowerCase();
  return !query || [
    session.title,
    session.preview,
    space.title,
    ...space.participants.map((participant) => participant.name),
  ].join(' ').toLowerCase().includes(query);
}
