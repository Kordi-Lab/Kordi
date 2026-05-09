export type KordiEdition = 'local' | 'cloud';
export type CloudSessionStatus = 'loading' | 'signed-out' | 'authenticated';

type EditionEnv = Partial<Record<'VITE_KORDI_EDITION' | 'KORDI_EDITION' | 'VITE_KORDI_WINDOW_TITLE', string | undefined>>;
type RuntimeEditionHints = {
  bootstrapEdition?: string;
  bootstrapTitle?: string;
  documentTitle?: string;
  locationSearch?: string;
};

export function normalizeKordiEdition(value: string | undefined | null): KordiEdition {
  return value?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'local';
}

export function kordiEditionFromEnv(env: EditionEnv): KordiEdition {
  const explicitEdition = normalizeKordiEdition(env.VITE_KORDI_EDITION ?? env.KORDI_EDITION);
  if (explicitEdition === 'cloud') return 'cloud';
  return env.VITE_KORDI_WINDOW_TITLE?.toLowerCase().includes('cloud') ? 'cloud' : 'local';
}

function usableBootstrapValue(value: string | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed && !trimmed.startsWith('%') ? trimmed : undefined;
}

export function kordiEditionFromRuntimeHints({
  bootstrapEdition,
  bootstrapTitle,
  documentTitle,
  locationSearch,
}: RuntimeEditionHints): KordiEdition {
  const edition = normalizeKordiEdition(usableBootstrapValue(bootstrapEdition));
  if (edition === 'cloud') return 'cloud';

  const title = `${usableBootstrapValue(bootstrapTitle) ?? ''} ${documentTitle ?? ''}`.toLowerCase();
  if (title.includes('cloud')) return 'cloud';

  const search = locationSearch ? new URLSearchParams(locationSearch) : null;
  return normalizeKordiEdition(search?.get('kordiEdition') ?? search?.get('edition'));
}

export function currentKordiEdition(): KordiEdition {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const browser = typeof window === 'undefined' ? null : window;
  const fromEnv = kordiEditionFromEnv({
    VITE_KORDI_EDITION: meta.env?.VITE_KORDI_EDITION,
    KORDI_EDITION: runtime.process?.env?.KORDI_EDITION,
    VITE_KORDI_WINDOW_TITLE: meta.env?.VITE_KORDI_WINDOW_TITLE,
  });
  if (fromEnv === 'cloud') return 'cloud';
  return kordiEditionFromRuntimeHints({
    bootstrapEdition: browser?.__KORDI_BOOTSTRAP__?.edition,
    bootstrapTitle: browser?.__KORDI_BOOTSTRAP__?.title,
    documentTitle: typeof document === 'undefined' ? undefined : document.title,
    locationSearch: browser?.location.search,
  });
}

export function shouldShowCloudLoginGate({
  edition,
  cloudSessionStatus,
}: {
  edition: KordiEdition;
  cloudSessionStatus: CloudSessionStatus;
}) {
  return edition === 'cloud' && cloudSessionStatus === 'signed-out';
}
