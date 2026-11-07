import { expect, test, type Locator, type Page } from '@playwright/test';

// The focus contract in src/styles/focus.css: focusing any control never draws
// an outline, an outer ring, or a blue or accent colour, and focus still shows
// as a border change (fields) or a fill (buttons, rows, tabs, chips).

const kinds = ['text-input', 'search-field', 'textarea', 'button-primary', 'button-quiet', 'chip', 'tab', 'list-row', 'danger-row', 'menu-row'];

type FocusLook = { outlineStyle: string; outlineWidth: string; boxShadow: string; borderColor: string; borderWidth: string; backgroundColor: string };

async function look(control: Locator): Promise<FocusLook> {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow, borderColor: style.borderTopColor, borderWidth: style.borderTopWidth, backgroundColor: style.backgroundColor };
  });
}

/** Resolves CSS colours to RGBA in the page, so oklab and color-mix values compare as numbers. */
async function rgba(page: Page, colors: string[]) {
  return page.evaluate((list) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    return list.map((color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    });
  }, colors);
}

function shadows(value: string) {
  if (!value || value === 'none') return [];
  const parts: string[] = [];
  let depth = 0; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth -= 1;
    else if (value[index] === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts.map((part) => {
    const text = part.trim();
    const colorMatch = text.match(/^(?:[a-z-]+\([^)]*\)|#[0-9a-f]+|[a-z]+)/i) ?? text.match(/(?:[a-z-]+\([^)]*\)|#[0-9a-f]+)$/i);
    const lengths = (text.replace(colorMatch?.[0] ?? '', '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    return { inset: /\binset\b/.test(text), color: colorMatch?.[0] ?? 'transparent', spread: lengths[3] ?? 0 };
  });
}

/** Blue or cyan hue with real chroma. */
function bluish({ r, g, b, a }: { r: number; g: number; b: number; a: number }) {
  if (a < 0.05) return false;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  // Tinted themes give their neutral ink a little chroma; a channel spread under
  // 48 stays a neutral, whatever its hue.
  if (max - min < 48) return false;
  const saturation = (max - min) / (255 - Math.abs(max + min - 255));
  let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 180 && hue <= 265 && saturation > 0.3;
}

async function accent(page: Page) {
  const value = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--app-palette-accent, var(--app-accent))';
    document.querySelector('.kordi-app')!.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  return (await rgba(page, [value]))[0];
}

async function expectNoRing(page: Page, control: Locator, label: string) {
  await control.evaluate((element) => (element as HTMLElement).blur());
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  const before = await look(control);
  await page.keyboard.press('Shift');
  await control.focus();
  await expect(control, label).toBeFocused();
  // Controls transition their colours; read the settled focus state.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  const after = await look(control);

  expect(after.outlineStyle === 'none' || after.outlineWidth === '0px', `${label}: outline ${after.outlineStyle} ${after.outlineWidth}`).toBe(true);
  const ring = shadows(after.boxShadow);
  for (const shadow of ring) expect(shadow.inset || shadow.spread <= 0, `${label}: outer ring ${after.boxShadow}`).toBe(true);
  const reference = await accent(page);
  const border = after.borderWidth === '0px' ? [] : [after.borderColor];
  const colors = await rgba(page, [...border, ...ring.map((shadow) => shadow.color)]);
  for (const color of colors) {
    expect(bluish(color), `${label}: blue focus colour ${JSON.stringify(color)} in ${after.borderColor} / ${after.boxShadow}`).toBe(false);
    const nearAccent = Math.abs(color.r - reference.r) + Math.abs(color.g - reference.g) + Math.abs(color.b - reference.b) < 24 && color.a > 0.3;
    expect(nearAccent, `${label}: accent focus colour ${JSON.stringify(color)}`).toBe(false);
  }
  const changed = before.borderColor !== after.borderColor || before.boxShadow !== after.boxShadow || before.backgroundColor !== after.backgroundColor;
  expect(changed, `${label}: focus is not perceivable`).toBe(true);
}

for (const chatTheme of ['classic', 'ocean'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`every control kind focuses without a ring (${chatTheme}, ${theme})`, async ({ page }) => {
      await page.goto(`/tests/visual/focusRingGallery.html?theme=${theme}&chatTheme=${chatTheme}`);
      await expect(page.locator('[data-focus-gallery-ready]')).toBeVisible();
      for (const scope of ['canvas', 'dialog']) {
        for (const kind of kinds) {
          await expectNoRing(page, page.locator(`[data-focus-kind="${scope}:${kind}"]`), `${scope} ${kind}`);
        }
      }
      // The provider search from the settings sheet, inside the dialog surface.
      await expectNoRing(page, page.getByRole('textbox', { name: 'Search providers' }), 'dialog provider search');
    });
  }
}

test('real settings surfaces focus without a ring', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.goto(`/tests/visual/authProviderConfig.html?variant=settings&theme=${theme}`);
    await expectNoRing(page, page.getByRole('textbox', { name: 'Search providers' }), `provider search (${theme})`);
    await page.goto(`/tests/visual/memorySettings.html?theme=${theme}`);
    await expect(page.getByRole('heading', { name: 'All memories · 10' })).toBeVisible();
    await expectNoRing(page, page.locator('.mo-find input'), `memory search (${theme})`);
    await expectNoRing(page, page.getByPlaceholder('Search', { exact: true }), `settings search (${theme})`);
    await expectNoRing(page, page.locator('.app-settings-nav-item').first(), `settings nav item (${theme})`);
  }
});
