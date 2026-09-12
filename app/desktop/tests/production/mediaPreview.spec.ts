import { expect, test } from '@playwright/test';

for (const nativeMaterial of [false, true]) {
  test(`media reveal and reactivation keep decoded pixels stable (${nativeMaterial ? 'native material' : 'CSS fallback'})`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.addInitScript((nativeMaterial) => {
      const events: Array<Record<string, unknown>> = [];
      const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="teal"/></svg>');
      const payload = { requestId: 'synthetic-media', theme: 'light', selectedIndex: 30, initialPreviewUrl: image,
        attachments: Array.from({ length: 32 }, (_, index) => ({ kind: 'image', name: `Synthetic ${index}.svg`, attachmentId: `synthetic-${index}`, previewUrl: image })) };
      let nativeTheme: unknown = null;
      let callbackId = 0;
      const target = window as unknown as Record<string, unknown>;
      target.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__ = payload;
      target.__KORDI_ATTACHMENT_MEDIA_NATIVE_MATERIAL__ = nativeMaterial;
      target.__mediaTestEvents = events;
      target.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'media-preview' }, currentWebview: { label: 'media-preview' } },
        transformCallback: () => ++callbackId,
        unregisterCallback: () => {},
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'plugin:window|set_theme') {
            events.push({ type: 'theme', theme: args?.value });
            await new Promise(resolve => setTimeout(resolve, 150)); nativeTheme = args?.value;
          } else if (command === 'desktop_reveal_media_preview_window') {
            const img = document.querySelector<HTMLImageElement>('.app-attachment-image-lightbox-image');
            events.push({ type: 'reveal', nativeTheme, pageTheme: document.documentElement.dataset.attachmentMediaTheme,
              complete: img?.complete, width: img?.naturalWidth });
          } else if (command === 'plugin:event|emit') events.push({ type: 'emit', event: args?.event });
          return 1;
        },
      };
    }, nativeMaterial);
    await page.goto('/?mediaPreview=1&mediaPreviewRequest=synthetic-media');
    const events = () => page.evaluate(() => (window as unknown as { __mediaTestEvents: Array<Record<string, unknown>> }).__mediaTestEvents);
    await expect.poll(async () => (await events()).filter(event => event.type === 'reveal').length).toBe(1);
    expect((await events()).filter(event => event.type === 'theme')).toEqual([{ type: 'theme', theme: 'light' }]);
    expect((await events()).find(event => event.type === 'reveal')).toMatchObject({ nativeTheme: 'light', pageTheme: 'light', complete: true, width: 640 });
    expect((await events()).some(event => event.event === 'kordi://attachment-media-ready')).toBe(false);
    await expect(page.getByLabel('Image 31 of 32', { exact: true })).toBeVisible();
    const dialog = page.getByRole('dialog');
    const backdrop = await dialog.evaluate(node => getComputedStyle(node).getPropertyValue('backdrop-filter'));
    // The production bundle targets native WebKit and retains the prefixed filter.
    const supportsBackdrop = await page.evaluate(() => CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
    expect(backdrop).toBe(!nativeMaterial && supportsBackdrop ? 'blur(34px) saturate(1.24)' : 'none');
    const image = page.locator('.app-attachment-image-lightbox-image');
    const handle = await image.elementHandle();
    const before = await image.boundingBox();
    const mutations = await page.evaluate(async () => {
      const image = document.querySelector('.app-attachment-image-lightbox-image')!;
      let sourceChanges = 0;
      const observer = new MutationObserver(records => { sourceChanges += records.length; });
      observer.observe(image, { attributes: true, attributeFilter: ['src'] });
      for (let cycle = 0; cycle < 3; cycle++) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
        await new Promise(requestAnimationFrame);
        Reflect.deleteProperty(document, 'visibilityState');
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        await new Promise(requestAnimationFrame);
      }
      observer.disconnect();
      return sourceChanges;
    });
    expect(mutations).toBe(0);
    expect(await handle!.evaluate(node => node.isConnected && node === document.querySelector('.app-attachment-image-lightbox-image'))).toBe(true);
    expect(await image.boundingBox()).toEqual(before);
    expect((await events()).filter(event => event.type === 'reveal')).toHaveLength(1);
    expect((await events()).filter(event => event.type === 'theme')).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}
