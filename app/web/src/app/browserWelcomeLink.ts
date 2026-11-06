/** The account pages send a newly created account to `/app/?welcome=1`. */
export const BROWSER_WELCOME_PARAM = 'welcome';

type WelcomeLinkWindow = Pick<Window, 'location' | 'history'>;

/**
 * Reads the first-run hand-off once and removes it from the address bar, so a
 * reload or a shared link never repeats it. Other query and hash values stay.
 */
export function takeBrowserWelcomeLink(browser: WelcomeLinkWindow = window): boolean {
  let url: URL;
  try {
    url = new URL(browser.location.href);
  } catch {
    return false;
  }
  if (!url.searchParams.has(BROWSER_WELCOME_PARAM)) return false;
  const requested = url.searchParams.get(BROWSER_WELCOME_PARAM) === '1';
  url.searchParams.delete(BROWSER_WELCOME_PARAM);
  try {
    browser.history.replaceState(browser.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The welcome still shows; only the address bar keeps the parameter.
  }
  return requested;
}
