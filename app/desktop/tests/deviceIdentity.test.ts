import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __resetDeviceIdentityForTests,
  installationDeviceRegistration,
} from '../src/features/cloud/deviceIdentity';

async function withNativeShell<T>(
  invoke: (command: string) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
  __resetDeviceIdentityForTests();
  try {
    return await run();
  } finally {
    __resetDeviceIdentityForTests();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function nativeShell(identity: unknown, commands: string[]) {
  return async (command: string) => {
    commands.push(command);
    switch (command) {
      case 'cloud_device_identity_public':
        return identity;
      case 'cloud_device_system_metadata':
        return { displayName: 'Mac', platform: 'macos', osVersion: '15.0', timeZone: null, countryCode: null };
      case 'plugin:app|version':
        return '1.2.3';
      default:
        return null;
    }
  };
}

test('the desktop registers the native public key and never handles the private key', async () => {
  const commands: string[] = [];
  const identity = { publicKeySpki: 'native-public-key', keyAlgorithm: 'p256' };
  await withNativeShell(nativeShell(identity, commands), async () => {
    const registration = await installationDeviceRegistration();
    assert.equal(registration.publicKey, 'native-public-key');
    assert.equal(registration.keyAlgorithm, 'p256');
    assert.equal(registration.platform, 'macos');
    assert.equal(registration.appVersion, '1.2.3');
    assert.deepEqual(
      commands.filter((command) => command.startsWith('cloud_device_identity')),
      ['cloud_device_identity_public'],
    );
  });
});

test('an unusable native identity fails registration instead of creating a webview key', async () => {
  for (const identity of [null, { publicKeySpki: '', keyAlgorithm: 'p256' }, { publicKeySpki: 'key', keyAlgorithm: 'rsa' }]) {
    const commands: string[] = [];
    await withNativeShell(nativeShell(identity, commands), async () => {
      await assert.rejects(installationDeviceRegistration(), /Secure installation identity is unavailable/);
      // A failed attempt is not cached, so the next sign-in asks again.
      await assert.rejects(installationDeviceRegistration());
      assert.equal(commands.filter((command) => command === 'cloud_device_identity_public').length, 2);
    });
  }
});
