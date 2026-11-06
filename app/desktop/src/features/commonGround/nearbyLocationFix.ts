import { invokeDesktop, isNativeDesktopShell } from '@/lib/desktop';

export type NearbyDeviceFix = { latitude: number; longitude: number; accuracy: number; timestamp: number };
export type NearbyLocationInput = { latitude: number; longitude: number; accuracy: number; capturedAt: string };

/** Validate freshness and accuracy, and round coordinates before they leave the device. */
export function nearbyLocationInput(fix: NearbyDeviceFix, now = Date.now()): NearbyLocationInput {
  if (![fix.latitude, fix.longitude, fix.accuracy, fix.timestamp].every(Number.isFinite)
    || Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180 || fix.accuracy < 0
    || fix.timestamp < now - 600_000 || fix.timestamp > now + 60_000) {
    throw new Error('Could not get a current location. Try again.');
  }
  if (fix.accuracy > 2000) throw new Error('Your location is not precise enough. Check Location Services and Wi-Fi, then try again.');
  return { latitude: Math.round(fix.latitude * 1000) / 1000, longitude: Math.round(fix.longitude * 1000) / 1000, accuracy: Math.round(fix.accuracy), capturedAt: new Date(fix.timestamp).toISOString() };
}

/** A location failure; `settings` means System Settings can fix it. */
export class NearbyLocationError extends Error {
  constructor(message: string, readonly settings = false) {
    super(message);
    this.name = 'NearbyLocationError';
  }
}

const allowInSettings = 'Allow Kordi in Location Services, then try again.';
const notFound = 'Could not find your location. Check Wi-Fi, then try again.';
const NATIVE_FAILURES: Record<string, [message: string, settings: boolean]> = {
  location_denied: [allowInSettings, true],
  location_services_off: ['Turn on Location Services, then try again.', true],
  location_permission_pending: ['Allow location access for Kordi, then try again.', true],
  location_not_bundled: ['This build cannot ask for location. Start it with pnpm dev:desktop:profile.', false],
  location_timeout: [notFound, false],
  location_unavailable: [notFound, false],
  location_busy: ['Already finding your location.', false],
};

/** Map a native failure code to copy; other errors pass through unchanged. */
export function nearbyNativeLocationError(error: unknown): Error {
  const code = error instanceof Error ? error.message : String(error);
  const known = NATIVE_FAILURES[code];
  if (known) return new NearbyLocationError(known[0], known[1]);
  return error instanceof Error ? error : new Error(notFound);
}

/** A single foreground fix, only after the user chooses to use this device. */
export async function requestNearbyDeviceLocation(): Promise<NearbyLocationInput> {
  if (isNativeDesktopShell() && /Mac/.test(navigator.platform)) {
    let fix: NearbyDeviceFix;
    try {
      // Asks macOS for access on first use, then reads one fix.
      fix = await invokeDesktop<NearbyDeviceFix>('desktop_nearby_location');
    } catch (error) {
      throw nearbyNativeLocationError(error);
    }
    return nearbyLocationInput(fix);
  }
  if (!navigator.geolocation) throw new Error('Location is unavailable on this device. Use another signed-in device.');
  const fix = await new Promise<NearbyDeviceFix>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, timestamp }),
      (error) => reject(new Error(error.code === 1
        ? 'Allow location access for Kordi in your browser or device settings, then try again.'
        : 'Could not find your location. Check Location Services and try again.')),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
    );
  });
  return nearbyLocationInput(fix);
}
