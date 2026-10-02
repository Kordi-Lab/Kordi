import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '../../node_modules/@tauri-apps/api/core.js';
export * from '../../node_modules/@tauri-apps/api/core.js';

// Selected only by the synthetic native-preview Vite config. Production and
// normal development builds continue to use the original Tauri core module.
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const host = window as unknown as { syntheticPreviewInvoke?: (command: string, args?: InvokeArgs) => Promise<T> };
  if (import.meta.env.DEV && host.syntheticPreviewInvoke) return host.syntheticPreviewInvoke(command, args);
  return nativeInvoke<T>(command, args, options);
}
