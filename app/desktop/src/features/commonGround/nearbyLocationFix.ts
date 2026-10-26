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

/** A single foreground fix, only after the user chooses to use this device. */
export async function requestNearbyDeviceLocation(): Promise<NearbyLocationInput> {
  if (isNativeDesktopShell() && /Mac/.test(navigator.platform)) {
    return nearbyLocationInput(await invokeDesktop<NearbyDeviceFix>('desktop_nearby_location'));
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
