import { invokeDesktop } from './desktop';

type PickedAvatarImage = { name: string; contentType: string; bytes: number[] };

export async function pickNativeAvatarFile(): Promise<File | null> {
  const selected = await invokeDesktop<PickedAvatarImage | null>('desktop_pick_avatar_image');
  if (!selected) return null;
  return new File([Uint8Array.from(selected.bytes)], selected.name, { type: selected.contentType });
}
