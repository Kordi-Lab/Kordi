import assert from 'node:assert/strict';
import test from 'node:test';

import { groupAvatarMenuPlacement } from '../src/kordi-app/components/groupAvatarMenuPlacement';

const menu = { width: 180, height: 40 };
const windowBounds = { left: 0, top: 0, right: 900, bottom: 560 };

test('an avatar at the left edge of a narrow dialog opens its menu from that edge, not past it', () => {
  // Start group: a 32px avatar 11px inside a 284px popover.
  const dialog = { ...windowBounds, left: 306, right: 590 };
  const avatar = { left: 317, top: 55, width: 32, height: 32 };
  const placement = groupAvatarMenuPlacement(avatar, menu, dialog);
  assert.equal(placement.side, 'below');
  assert.equal(placement.left, avatar.left);
  assert.equal(placement.top, avatar.top + avatar.height + 6);
  assert.ok(placement.left >= dialog.left && placement.left + menu.width <= dialog.right);
});

test('a centred avatar with room on both sides keeps its menu centred under it', () => {
  const dialog = { ...windowBounds, left: 490, right: 794 };
  const avatar = { left: 610, top: 30, width: 64, height: 64 };
  const placement = groupAvatarMenuPlacement(avatar, menu, dialog);
  assert.equal(placement.left, avatar.left + (avatar.width - menu.width) / 2);
  assert.equal(placement.side, 'below');
});

test('an avatar near the right edge keeps the menu inside the bounds', () => {
  const avatar = { left: 870, top: 30, width: 24, height: 24 };
  const placement = groupAvatarMenuPlacement(avatar, menu, windowBounds);
  assert.equal(placement.left + menu.width, windowBounds.right - 8);
});

test('the menu opens above an avatar at the bottom of the window', () => {
  const avatar = { left: 100, top: 520, width: 32, height: 32 };
  const placement = groupAvatarMenuPlacement(avatar, menu, windowBounds);
  assert.equal(placement.side, 'above');
  assert.equal(placement.top, avatar.top - 6 - menu.height);
});
