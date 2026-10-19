/**
 * Development preview: the `tests/visual` Common ground page in the Contacts detail area. `app=1`
 * keeps simulated people out of the real app, so it shows only your own card.
 */
export function CommonGroundPreviewFrame({ displayName }: { displayName?: string }) {
  const theme = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
  return (
    <section aria-label="Common ground" className="flex min-h-0 min-w-0 flex-1">
      <iframe
        title="Common ground"
        src={`/tests/visual/commonGround.html?embedded=1&app=1&theme=${theme}${displayName ? `&name=${encodeURIComponent(displayName)}` : ''}`}
        className="block h-full w-full border-0"
        style={{ background: 'transparent', colorScheme: theme }}
      />
    </section>
  );
}
