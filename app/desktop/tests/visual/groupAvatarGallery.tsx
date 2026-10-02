import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupAvatar } from '../../src/kordi-app/components/GroupAvatar';
import { GroupAvatarEditor } from '../../src/kordi-app/components/GroupAvatarEditor';
import { IdentityAvatar } from '../../src/kordi-app/components/IdentityAvatar';
import '../../src/index.css';

const colors = ['#bad7ee', '#e0cbed', '#f7caaf', '#bcdfca', '#edcbbf', '#d7deb8', '#b6d8d7', '#c3c8ed', '#ead496'];
const names = ['Maya', 'Alex', 'Noah', 'Lily', 'Sam', 'Eva', 'Leo', 'Ivy', 'Ben'];
const portrait = (name: string, color: string) => 'data:image/svg+xml;base64,' + btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/><circle cx="50" cy="37" r="20" fill="#f9ebd4"/><path d="M16 100v-12a34 34 0 0 1 68 0v12" fill="#55627b"/><text x="50" y="88" text-anchor="middle" font-family="sans-serif" font-size="19" fill="white">${name[0]}</text></svg>`
);
const avatars = names.map((name, i) => ({ kind: 'human' as const, seed: name, imageUrl: portrait(name, colors[i]) }));

function Gallery() {
  const [image, setImage] = useState<string | null>(null);
  const dark = new URLSearchParams(location.search).get('theme') === 'dark';
  return <main className={`kordi-app theme-${dark ? 'dark' : 'light'} min-h-screen p-10 text-[var(--utility-foreground)]`} style={{ background: dark ? '#11151c' : '#f0f2f5' }}>
    <div className="mx-auto max-w-2xl space-y-6" data-visual-ready="true">
      <h1 className="text-xl font-semibold">Kordi · square avatars</h1>
      <div className="app-transient-surface rounded-2xl border border-[var(--utility-border)] p-6">
        <div className="mb-6 flex items-center gap-4">
          <GroupAvatar avatars={avatars} imageUrl={image} name="Research group" className="h-16 w-16" />
          <div><h2 className="text-lg font-semibold">Research group</h2><p className="text-sm text-[var(--utility-muted-text)]">9 members · 3 channels</p></div>
        </div>
        <GroupAvatarEditor avatars={avatars} imageUrl={image} name="Research group" onUpload={setImage} onRemove={() => setImage(null)} />
      </div>
      <div className="app-transient-surface rounded-2xl border border-[var(--utility-border)] p-6">
        <h2 className="mb-4 text-sm font-semibold">Chats</h2>
        {[4, 9].map(count => <div className="flex items-center gap-3 py-3" key={count}>
          <GroupAvatar avatars={avatars.slice(0, count)} imageUrl={count === 9 ? image : null} name={count === 9 ? 'Research group' : 'Design team'} />
          <div><p className="text-sm font-medium">{count === 9 ? 'Research group' : 'Design team'}</p><p className="text-xs text-[var(--utility-muted-text)]">{count} members · Member collage</p></div>
        </div>)}
        <div className="flex items-center gap-3 py-3"><IdentityAvatar kind="human" seed="Maya" name="Maya" imageUrl={avatars[0].imageUrl} className="h-9 w-9" /><div><p className="text-sm font-medium">Maya</p><p className="text-xs text-[var(--utility-muted-text)]">Direct chat</p></div></div>
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Gallery />);
