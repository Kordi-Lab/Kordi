import { assert, rm, test, publishDesktopRelease, makeFixture, optionsFor, MemoryStore } from './test_support/publishDesktopReleaseFixtures.mjs';

test('publishing requires a verified numeric minimum before any storage mutation', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const minimumSystemVersion of [undefined, '13', '13.0 ', '013.0', '0.0', '65536.0']) {
    const store = new MemoryStore();
    await assert.rejects(publishDesktopRelease(optionsFor(fixture), {
      verifier: { async verify() { return { minimumSystemVersion }; } },
      store,
      publicHttp: {},
    }), /Invalid macOS/);
    assert.equal(store.actions.length, 0);
  }
});
