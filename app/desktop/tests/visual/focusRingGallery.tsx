import './previewChatTheme';
import { createRoot } from 'react-dom/client';
import { Button } from '../../src/components/ui/button';
import { Input } from '../../src/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../../src/components/ui/tabs';
import { AuthProviderList } from '../../src/kordi-app/auth/AuthProviderList';

// One of each focusable control kind, on the app canvas and inside a dialog
// surface, for the focus contract in src/styles/focus.css. Synthetic, offline.
// ?theme=light|dark and ?chatTheme=classic|ocean|...
const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;
const noop = () => {};

function Controls({ scope }: { scope: string }) {
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
      <Input data-focus-kind={`${scope}:text-input`} aria-label="Name" placeholder="Name" />
      <input data-focus-kind={`${scope}:search-field`} type="search" aria-label="Search" placeholder="Search" className="app-input-shell app-flat-input h-9 w-full rounded-lg px-2.5 text-[13px]" />
      <textarea data-focus-kind={`${scope}:textarea`} aria-label="Note" placeholder="Note" className="app-input-shell app-flat-input min-h-16 w-full rounded-lg px-2.5 py-2 text-[13px]" />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button data-focus-kind={`${scope}:button-primary`}>Save</Button>
        <Button data-focus-kind={`${scope}:button-quiet`} variant="quiet">Cancel</Button>
        <button data-focus-kind={`${scope}:chip`} type="button" className="app-control-chip rounded-full border px-3 py-1 text-[12px]">Design</button>
      </div>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger data-focus-kind={`${scope}:tab`} value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
      </Tabs>
      <button data-focus-kind={`${scope}:list-row`} type="button" className="app-settings-nav-item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]">Profile</button>
      <button data-focus-kind={`${scope}:danger-row`} type="button" className="app-transient-row app-transient-row-danger rounded-lg border px-2.5 py-1.5 text-left text-[13px]">Delete</button>
      <div className="app-transient-surface app-dense-menu" role="menu" aria-label={`${scope} menu`}>
        <button data-focus-kind={`${scope}:menu-row`} type="button" role="menuitem" className="app-dense-menu-row"><span>Rename</span></button>
      </div>
    </div>
  );
}

function Gallery() {
  return (
    <div className={`kordi-app theme-${theme} min-h-screen`} style={{ background: 'var(--utility-background)', color: 'var(--utility-foreground)', padding: 24, display: 'flex', gap: 32 }} data-focus-gallery-ready>
      <section aria-label="App canvas"><Controls scope="canvas" /></section>
      <section aria-label="Dialog" className="app-transient-surface app-modal-panel rounded-2xl border" style={{ padding: 20, width: 520 }}>
        <Controls scope="dialog" />
        <div style={{ marginTop: 16, height: 120 }}>
          <AuthProviderList providers={[]} onSelectProvider={noop} onRefresh={noop} />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Gallery />);
