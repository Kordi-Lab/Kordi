import { test, expect } from '@playwright/test';
test.use({ reducedMotion: 'no-preference' });
for (const theme of ['light', 'dark']) {
 test(`${theme}: smooth document tab navigation and overflow`, async ({ page }, testInfo) => {
 await page.setViewportSize({width:1440,height:900});
 const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/tests/visual/companionDocuments.html?tabs=12&theme=${theme}`);
 const list=page.getByRole('tablist',{name:'Open documents',exact:true});
 const next=page.getByRole('button',{name:'Next tabs',exact:true});
 const previous=page.getByRole('button',{name:'Previous tabs',exact:true});
 await expect(list).toBeVisible();
 await expect(previous).toBeDisabled();
 const geometry=()=>list.evaluate(el=>{const tab=el.querySelector('.app-document-tab')!;const step=tab.getBoundingClientRect().width+3;return {x:el.scrollLeft,max:el.scrollWidth-el.clientWidth,step,restError:Math.abs(el.scrollLeft/step-Math.round(el.scrollLeft/step))*step};});
 const settled=async()=>{await page.waitForTimeout(650);expect((await geometry()).restError).toBeLessThan(1.5);};
 // A single step keeps adjacent tabs in context instead of replacing a page.
 await next.click();await settled();
 let g=await geometry();expect(Math.abs(g.x-g.step)).toBeLessThan(1.5);
 await expect(page.getByRole('tab',{name:'notes.txt',exact:true})).toHaveAttribute('aria-selected','true');
 // Rapid input must accumulate rather than lose clicks or overshoot.
 await next.click({clickCount:3,delay:45});await settled();
 g=await geometry();expect(Math.abs(g.x-g.step*4)).toBeLessThan(1.5);
 // Native trackpad wheel is continuous during motion, then snaps to full tabs.
 await list.hover();await page.mouse.wheel(245,0);await settled();
 expect((await geometry()).x).toBeGreaterThan(g.x);
 await page.mouse.wheel(10000,0);await settled();
 await expect(next).toBeDisabled();g=await geometry();expect(Math.abs(g.max-g.x)).toBeLessThan(1.5);
 const pageOffset=await page.evaluate(()=>({x:scrollX,y:scrollY}));
 await page.mouse.wheel(900,0);await settled();
 expect(await page.evaluate(()=>({x:scrollX,y:scrollY}))).toEqual(pageOffset);
 await page.mouse.wheel(-10000,0);await settled();await expect(previous).toBeDisabled();
 await page.keyboard.down('Shift'); await page.mouse.wheel(0,220); await page.keyboard.up('Shift'); await settled();
 expect((await geometry()).x).toBeGreaterThan(0);
 // Search reveals the selection, including the already-selected offscreen tab.
 await page.getByRole('button',{name:'All open documents',exact:true}).click();
 await page.getByRole('textbox',{name:'Search open documents'}).fill('nothing-matches');
 await expect(page.getByText('No matching documents')).toBeVisible();
 await page.getByRole('textbox',{name:'Search open documents'}).fill('handoff');
 await page.keyboard.press('Enter');await settled();
 await expect(page.getByRole('tab',{name:'handoff-notes.txt',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(next).toBeDisabled();
 for(const width of [1200,1000,1600]){
  await page.setViewportSize({width,height:900});await settled();
  const visible=await list.evaluate(el=>{const a=el.querySelector('[aria-selected="true"]')!.getBoundingClientRect(),b=el.getBoundingClientRect();return a.left>=b.left-1.5&&a.right<=b.right+1.5;});expect(visible).toBe(true);
 }
 await page.getByRole('tab',{name:'handoff-notes.txt',exact:true}).focus();
 await page.keyboard.press('Home');await settled();await expect(previous).toBeDisabled();
 await page.keyboard.press('End');await settled();await expect(next).toBeDisabled();
 // Reduced motion must settle immediately.
 await page.emulateMedia({reducedMotion:'reduce'});
 await previous.click();
 g=await geometry();expect(g.restError).toBeLessThan(1.5);
 await page.screenshot({path:testInfo.outputPath(`scroll-${theme}.png`)});
 expect(errors).toEqual([]);
 });
}


for (const theme of ['light', 'dark']) {
 test(`${theme}: folding restores document readers and tab state`, async ({ page }, testInfo) => {
 await page.setViewportSize({width:1440,height:800});
 const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/tests/visual/companionDocuments.html?tabs=6&theme=${theme}`);
 await expect(page.getByRole('tab',{name:'notes.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Wrap lines',exact:true}).click();
 const source=page.locator('.app-companion-source:visible');
 await source.evaluate(e=>{e.scrollLeft=160;(e as HTMLElement).dataset.retainedReader='true';});
 const left=await source.evaluate(e=>e.scrollLeft);
 await page.getByRole('button',{name:'Fold pane',exact:true}).last().click();
 await expect(page.getByRole('button',{name:'Expand pane',exact:true})).toBeVisible();
 await page.waitForTimeout(700);
 await expect(page.getByRole('complementary',{name:'Document panel'})).not.toBeVisible();
 await page.screenshot({path:testInfo.outputPath(`folded-${theme}.png`)});
 await page.getByRole('button',{name:'Expand pane',exact:true}).click();
 await expect(page.getByRole('tab',{name:'notes.txt',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(page.getByRole('button',{name:'Wrap lines',exact:true})).toHaveAttribute('aria-pressed','false');
 expect(await source.evaluate(e=>(e as HTMLElement).dataset.retainedReader === 'true')).toBe(true);
 expect(await source.evaluate(e=>e.scrollLeft)).toBe(left);
 await page.getByRole('button',{name:'All open documents',exact:true}).click();
 await expect(page.getByRole('menuitem')).toHaveCount(6);
 await page.getByRole('textbox',{name:'Search open documents'}).press('ArrowUp');
 await expect(page.getByRole('menuitem',{name:'implementation-checklist.txt'})).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'All open documents',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'All open documents',exact:true}).click();
 await page.getByRole('menuitem',{name:'release-notes-november-document-review.txt'}).click();
 await page.getByRole('button',{name:'Fold pane',exact:true}).first().click();
 await page.waitForTimeout(600);
 await page.getByRole('button',{name:'Expand pane',exact:true}).click();
 await expect(page.getByRole('tab',{name:'release-notes-november-document-review.txt',exact:true})).toHaveAttribute('aria-selected','true');
 await page.waitForTimeout(500);
 await page.screenshot({path:testInfo.outputPath(`expanded-${theme}.png`)});
 expect(errors).toEqual([]);
 });
}

for (const theme of ['light', 'dark']) {
 test(`${theme}: Chat, Digest, Calendar and documents share one tab strip`, async ({ page }, testInfo) => {
  await page.goto(`/tests/visual/companionDocuments.html?tabs=2&theme=${theme}`);
  const toolbar = page.getByRole('group', { name: 'Companion panel' });
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Digest', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Digest', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Synthetic digest for the shared pane.')).toBeVisible();
  await toolbar.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  const calendarMonth = await page.locator('.app-companion-month-heading h3').textContent();
  await toolbar.getByRole('button', { name: 'Chat', exact: true }).click();
  const chatTab = page.getByRole('tab', { name: 'Private review', exact: true });
  await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  const draft = page.locator('[data-chat-side-agent-panel] [contenteditable="true"]').first();
  await draft.fill('Keep this private draft');
  await toolbar.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(chatTab).toHaveCount(1);
  await page.getByRole('tab', { name: 'notes.txt', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open tabs', exact: true }).getByRole('tab')).toHaveCount(5);
  await toolbar.getByRole('button', { name: 'Fold pane', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Expand pane', exact: true }).click();
  await page.getByRole('tab', { name: 'Calendar', exact: true }).click();
  await expect(page.locator('.app-companion-month-heading h3')).toHaveText(calendarMonth!);
  await page.getByRole('tab', { name: 'Private review', exact: true }).click();
  await expect(draft).toHaveText('Keep this private draft');
  await page.getByRole('button', { name: 'All open tabs', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search open tabs' }).fill('Digest');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath(`shared-tabs-${theme}.png`) });
  await page.getByRole('button', { name: 'Close Digest', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Calendar', exact: true })).toHaveAttribute('aria-selected', 'true');
  await toolbar.getByRole('button', { name: 'Digest', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Digest', exact: true })).toHaveCount(1);
  for (let remaining = 5; remaining > 0; remaining--) {
    const strip = page.getByRole('tablist', { name: /^Open (tabs|documents)$/ });
    await expect(strip.getByRole('tab')).toHaveCount(remaining);
    await strip.locator('[aria-selected="true"]').focus();
    await page.keyboard.press('Delete');
  }
  await toolbar.getByRole('button', { name: 'Expand pane', exact: true }).click();
  await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tablist', { name: 'Open tabs', exact: true }).getByRole('tab')).toHaveCount(1);
 });
}

for (const theme of ['light', 'dark']) {
 test(`${theme}: Chat navigation aligns with the main conversation`, async ({ page }, testInfo) => {
  await page.goto(`/tests/visual/companionDocuments.html?tabs=2&theme=${theme}`);
  await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true }).click();
  const panel = page.locator('[data-chat-side-agent-panel]');
  await expect(panel).toBeVisible();
  for (const width of [1100, 1800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(650);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const main = box('[data-chat-destination-tabs="main"]');
      const side = box('[data-chat-destination-tabs="companion"]');
      const header = box('.app-companion-tabbed-header');
      const controls = box('.app-companion-header-controls');
      return { top: Math.abs(main.top - side.top), bottom: Math.abs(main.bottom - side.bottom), overlap: side.right - controls.left, outside: controls.right - header.right };
    });
    expect(geometry.top).toBeLessThan(1);
    expect(geometry.bottom).toBeLessThan(1);
    expect(geometry.overlap).toBeLessThanOrEqual(0);
    expect(geometry.outside).toBeLessThanOrEqual(0);
  }
  await panel.getByRole('button', { name: 'Side chat options' }).click();
  await expect(panel.getByRole('heading', { name: 'Private review' })).toBeVisible();
  await expect(panel.getByText('Ask Agent · Only you · Agent session')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Switch Chat', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Side chat options' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`aligned-chat-${theme}.png`) });
 });
}
