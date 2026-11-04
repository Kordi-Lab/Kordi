import { createRoot } from 'react-dom/client';
import { KordiAppRoot } from '../../src/KordiApp';
import type { BrowserSignInDriver } from '../../src/features/cloud/appSignIn/browserSignIn';
import '../../src/index.css';

// Synthetic browser sign-in: the server offers it, the browser never returns,
// and pasted codes are refused, so every screen stays inspectable.
const params = new URLSearchParams(location.search);
localStorage.setItem('kordi.themeMode.v1', params.get('theme') === 'dark' ? 'dark' : 'light');
localStorage.removeItem('kordi.cloud.loginMode');

const driver: BrowserSignInDriver = {
  prepare: async () => ({ requestId: 'visual', redirectUrl: 'http://127.0.0.1:4321/auth/callback' }),
  wait: () => new Promise<string>(() => {}),
  cancel: async () => {},
  openUrl: async () => {},
  copyText: async () => {},
};
const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes('/authorize?') ? { error: 'invalid_redirect_uri' } : { error: 'invalid_grant' };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <KordiAppRoot cloudSession={{
    status: 'signed-out', account: null,
    signIn: () => Promise.reject(new Error('Test sign-in failed.')),
    signUp: () => Promise.reject(new Error('Test signup failed.')),
    signInWithProvider: () => Promise.reject(new Error('Test provider failed.')),
    browserSignIn: {
      config: {
        baseUrl: 'https://app.example.test', clientId: 'kordi-desktop', fetchImpl, driver,
        deviceRegistration: () => Promise.reject(new Error('No device in previews.')),
      },
      complete: async () => {},
    },
  }} />,
);
