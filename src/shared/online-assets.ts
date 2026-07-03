export type AssetHostMode = 'local' | 'primary' | 'backup';

export function configureOnlineAssetHosts(
  _primaryBase: string,
  _backupBase?: string | null,
): void {}

export function clearOnlineAssetHosts(): void {}

export function resetOnlineAssetHostPreference(): void {}

export function setPreferredOnlineAssetHostMode(
  _mode: 'primary' | 'backup',
): void {}

export function getAssetHostInfo(
  _manifestSource: string,
): { mode: AssetHostMode; base: string | null } {
  return { mode: 'local', base: null };
}

export function resolveOnlineAssetUrl(pathOrUrl: string): string {
  return pathOrUrl;
}

export async function fetchWithOnlineAssetFallback(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}
