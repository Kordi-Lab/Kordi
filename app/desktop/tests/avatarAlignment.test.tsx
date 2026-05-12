import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Avatar } from '../src/components/ui/avatar';

test('avatar wrapper centers generated and uploaded avatar content', () => {
  const element = Avatar({ className: 'h-9 w-9' }) as { props: { className: string } };
  assert.match(element.props.className, /items-center/);
  assert.match(element.props.className, /justify-center/);
  assert.match(element.props.className, /h-9/);
  assert.match(element.props.className, /w-9/);
});
