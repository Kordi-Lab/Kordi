import { expect, test } from '@playwright/test';
import { chatConversationId, installChatFixture } from './chatFixture';

// Chromium's synthetic microphone supplies actual MediaRecorder audio frames.
// This exercises encoding/upload wiring, not physical microphone permissions.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] });
test.skip(({ browserName }) => browserName !== 'chromium', 'Synthetic microphone capture is configured for Chromium only.');

test('browser microphone records playable WAV bytes and sends a voice message', async ({ page, baseURL }) => {
  const fixture = await installChatFixture(page, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/app/chats/${encodeURIComponent(chatConversationId)}`);
  await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel voice recording', exact: true })).toBeVisible();
  // The product rejects recordings below one second; capture actual frames.
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: 'Stop and send voice message', exact: true }).click();
  await expect.poll(() => fixture.uploads.length).toBeGreaterThan(0);
  const audio = fixture.uploads[0];
  expect(audio.subarray(0, 4).toString()).toBe('RIFF');
  expect(audio.subarray(8, 12).toString()).toBe('WAVE');
  expect(audio.length).toBeGreaterThan(1024);
  await expect.poll(() => fixture.sent.length).toBe(1);
  const sent = fixture.sent[0] as { content: { blocks: { type: string; mimeType?: string }[] } };
  expect(sent.content.blocks.some(block => block.mimeType === 'audio/wav')).toBe(true);
  expect(errors).toEqual([]);
});
