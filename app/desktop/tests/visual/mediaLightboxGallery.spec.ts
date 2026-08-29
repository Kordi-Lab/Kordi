import { expect, test } from '@playwright/test';

test('link previews stay compact with long tracking URLs', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=light&surface=link-preview');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();

  const cards = page.locator('.app-message-link-preview');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAccessibleName(/xiaohongshu\.com/);
  await expect(cards.first()).not.toContainText('xsec_token');
  const wideBox = await cards.first().boundingBox();
  const bubbleBox = await page.getByLabel('Link preview message 1')
    .locator('[data-message-context-menu-anchor="true"]')
    .boundingBox();
  expect(wideBox).not.toBeNull();
  expect(bubbleBox).not.toBeNull();
  expect(wideBox!.height).toBeGreaterThanOrEqual(88);
  expect(wideBox!.height).toBeLessThanOrEqual(96);
  expect(bubbleBox!.width - wideBox!.width).toBeLessThanOrEqual(34);
  await page.screenshot({ path: testInfo.outputPath('link-previews-wide-light.png') });

  await page.setViewportSize({ width: 320, height: 720 });
  const narrowCard = cards.first();
  const box = await narrowCard.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('link-previews-narrow-light.png') });
});

test('a synced standalone image keeps its natural aspect ratio after remote preview loading', async ({ page }) => {
  await page.route('**/v1/cloud/attachments/visual-remote-preview/content', async (route) => {
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="#29413A"/><circle cx="960" cy="360" r="180" fill="#7BC7B2"/></svg>',
    });
  });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=dark&surface=remote-transcript');

  const image = page.getByLabel('Remote transcript image').locator('img');
  await expect(image).toHaveAttribute('data-attachment-image-loaded', 'true');
  const imageBox = await image.boundingBox();
  expect(imageBox).not.toBeNull();
  expect(imageBox!.height).toBeGreaterThan(200);
  expect(imageBox!.width / imageBox!.height).toBeCloseTo(1.6, 1);
});

test('failed image retry stays beside the image and reports retry progress', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=dark&surface=retry-transcript');

  const message = page.getByLabel('Failed transcript image');
  const image = message.locator('img');
  const retry = message.locator('[data-message-retry-button="true"]');
  await expect(retry).toHaveAccessibleName('Retry sending image');
  const [imageBox, retryBox] = await Promise.all([image.boundingBox(), retry.boundingBox()]);
  expect(imageBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(imageBox!.x);
  expect(Math.abs(
    (retryBox!.y + retryBox!.height / 2) - (imageBox!.y + imageBox!.height / 2),
  )).toBeLessThanOrEqual(3);

  await retry.click();
  await expect(retry).toHaveAttribute('data-message-retry-state', 'retrying');
  await expect(retry).toBeDisabled();
  await expect(retry).toContainText('Retrying…');
  await expect(retry.locator('.animate-spin')).toBeVisible();
});

test('media lightbox remains image-first across desktop sizes and themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=dark&index=1');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();

  const lightbox = page.getByRole('dialog', { name: 'Image preview: Quiet signal portrait.png' });
  const image = lightbox.locator('img');
  const previous = page.getByRole('button', { name: 'Previous image' });
  const next = page.getByRole('button', { name: 'Next image' });
  await expect(lightbox).toBeVisible();
  await expect(previous).toHaveCSS('opacity', '0.56');
  await expect(next).toHaveCSS('opacity', '0.56');
  await expect(previous).toHaveCSS('width', '48px');
  await expect(previous).toHaveCSS('height', '48px');
  await expect(previous).toHaveCSS('border-radius', '999px');
  await expect(next).toHaveCSS('width', '48px');
  await expect(next).toHaveCSS('height', '48px');
  await expect(next).toHaveCSS('border-radius', '999px');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  const wideBox = await image.boundingBox();
  expect(wideBox).not.toBeNull();
  expect(wideBox!.x).toBeGreaterThanOrEqual(60);
  expect(wideBox!.y).toBeGreaterThanOrEqual(60);
  await expect(page).toHaveScreenshot('media-lightbox-wide-dark.png');

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(image).toHaveAttribute('data-attachment-image-zoom', '1.25');
  await expect(page).toHaveScreenshot('media-lightbox-wide-dark-zoomed.png');

  await next.hover();
  await expect(next).toHaveCSS('opacity', '1');
  await expect(page).toHaveScreenshot('media-lightbox-wide-dark-navigation.png');

  await page.setViewportSize({ width: 720, height: 560 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=light&index=1');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
  const compactImage = page.getByRole('dialog', { name: 'Image preview: Quiet signal portrait.png' }).locator('img');
  const compactBox = await compactImage.boundingBox();
  expect(compactBox).not.toBeNull();
  expect(compactBox!.x).toBeGreaterThanOrEqual(50);
  expect(compactBox!.y).toBeGreaterThanOrEqual(40);
  expect(compactBox!.x + compactBox!.width).toBeLessThanOrEqual(670);
  expect(compactBox!.y + compactBox!.height).toBeLessThanOrEqual(536);
  await expect(page).toHaveScreenshot('media-lightbox-compact-light.png');

  await page.setViewportSize({ width: 760, height: 1500 });
  await page.goto('/tests/visual/mediaLightboxGallery.html?theme=dark&surface=transcript');
  await expect(page.locator('body[data-visual-ready="true"]')).toBeVisible();
  const ownTextShape = page.getByLabel('Transcript message 1').locator('[data-message-context-menu-anchor="true"]');
  const ownImage = page.getByLabel('Transcript message 2').locator('[data-attachment-image-count="1"] img');
  const peerTextShape = page.getByLabel('Transcript message 3').locator('[data-message-context-menu-anchor="true"]');
  const peerImage = page.getByLabel('Transcript message 4').locator('[data-attachment-image-count="1"] img');
  const singleImage = ownImage;
  const imageGroupMessage = page.getByLabel('Transcript message 5');
  const imageGroup = imageGroupMessage.locator('[data-attachment-image-count="3"]');
  const imageGroupDisclosure = imageGroupMessage.locator('[data-attachment-image-group-disclosure="true"]');
  const imageGroupAvatar = imageGroupMessage.getByLabel('Me avatar');
  const multiImage = imageGroup.locator('img').first();
  const [ownTextBox, ownImageBox, peerTextBox, peerImageBox] = await Promise.all([
    ownTextShape.boundingBox(),
    ownImage.boundingBox(),
    peerTextShape.boundingBox(),
    peerImage.boundingBox(),
  ]);
  expect(ownTextBox).not.toBeNull();
  expect(ownImageBox).not.toBeNull();
  expect(peerTextBox).not.toBeNull();
  expect(peerImageBox).not.toBeNull();
  expect(Math.abs((ownTextBox!.x + ownTextBox!.width) - (ownImageBox!.x + ownImageBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(peerTextBox!.x - peerImageBox!.x)).toBeLessThanOrEqual(1);
  await expect(singleImage).toHaveCSS('border-radius', '16px');
  await expect(page.locator('[data-attachment-image-collage="true"]').first()).toHaveCSS('border-radius', '16px');
  await expect(imageGroupDisclosure).toHaveAccessibleName('Expand 3');
  await expect(imageGroupDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(imageGroupDisclosure).toHaveCSS('height', '32px');
  await expect(imageGroupDisclosure).toHaveCSS('border-radius', '10px');
  await expect(imageGroup.locator('[data-attachment-image-card="true"]')).toHaveCount(3);
  await expect(imageGroup.locator('[data-attachment-image-card="true"][aria-hidden="true"]')).toHaveCount(2);
  await expect(multiImage).toHaveCSS('border-radius', '16px');
  const [collapsedDisclosureBox, collapsedGroupBox, imageGroupAvatarBox] = await Promise.all([
    imageGroupDisclosure.boundingBox(),
    imageGroup.boundingBox(),
    imageGroupAvatar.boundingBox(),
  ]);
  expect(collapsedDisclosureBox).not.toBeNull();
  expect(collapsedGroupBox).not.toBeNull();
  expect(imageGroupAvatarBox).not.toBeNull();
  expect(collapsedGroupBox!.x - (collapsedDisclosureBox!.x + collapsedDisclosureBox!.width)).toBeCloseTo(8, 0);
  expect(imageGroupAvatarBox!.x - (collapsedGroupBox!.x + collapsedGroupBox!.width)).toBeGreaterThanOrEqual(16);
  await expect(page).toHaveScreenshot('transcript-image-corners-dark.png');

  await imageGroupDisclosure.click();
  await expect(imageGroupDisclosure).toHaveAccessibleName('Collapse');
  await expect(imageGroupDisclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(imageGroup).toHaveAttribute('data-attachment-image-group-expanded', 'true');
  await expect(imageGroup.locator('[data-attachment-image-card="true"]')).toHaveCount(3);
  const [expandedDisclosureBox, expandedGroupBox] = await Promise.all([
    imageGroupDisclosure.boundingBox(),
    imageGroup.boundingBox(),
  ]);
  expect(expandedDisclosureBox).not.toBeNull();
  expect(expandedGroupBox).not.toBeNull();
  expect(Math.abs(expandedDisclosureBox!.x - collapsedDisclosureBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(expandedDisclosureBox!.y - collapsedDisclosureBox!.y)).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot('transcript-image-groups-expanded-dark.png');

  await imageGroupDisclosure.click();
  await page.setViewportSize({ width: 320, height: 1500 });
  const [narrowMessageBox, narrowGroupBox, narrowDisclosureBox] = await Promise.all([
    imageGroupMessage.boundingBox(),
    imageGroup.boundingBox(),
    imageGroupDisclosure.boundingBox(),
  ]);
  expect(narrowMessageBox).not.toBeNull();
  expect(narrowGroupBox).not.toBeNull();
  expect(narrowDisclosureBox).not.toBeNull();
  expect(narrowGroupBox!.x).toBeGreaterThanOrEqual(narrowMessageBox!.x);
  expect(narrowGroupBox!.x + narrowGroupBox!.width).toBeLessThanOrEqual(narrowMessageBox!.x + narrowMessageBox!.width);
  expect(narrowDisclosureBox!.x).toBeGreaterThanOrEqual(narrowMessageBox!.x);
  expect(narrowDisclosureBox!.x + narrowDisclosureBox!.width).toBeLessThanOrEqual(narrowMessageBox!.x + narrowMessageBox!.width);
  expect(narrowGroupBox!.x - (narrowDisclosureBox!.x + narrowDisclosureBox!.width)).toBeCloseTo(8, 0);
  expect(await imageGroupMessage.locator('[data-message-context-menu-anchor="true"]').evaluate((anchor) => (
    getComputedStyle(anchor.parentElement!).alignItems
  ))).toBe('flex-start');
});
