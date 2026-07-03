export type ManifestSource = 'local' | 'online';

export interface AdvancedSettings {
  lockedScaleId: string | null;
  manifestSource: ManifestSource;
  verboseLogging: boolean;
  hiddenScaleIds: string[];
  audioMutedByDefault: boolean;
  defaultAudioVolume: number;
  lockFullscreen: boolean;
}

const STORAGE_KEY = 'moon-engine-advanced-settings';
const FORCED_MANIFEST_SOURCE = getForcedManifestSource();
const FORCED_LOCKED_SCALE_ID = getForcedLockedScaleId();

export const ADVANCED_SETTINGS_PASSWORD = 'RSSSE26UM_Engine';

export function getDefaultAdvancedSettings(): AdvancedSettings {
  return {
    lockedScaleId: FORCED_LOCKED_SCALE_ID ?? null,
    manifestSource: FORCED_MANIFEST_SOURCE ?? 'local',
    verboseLogging: false,
    hiddenScaleIds: [],
    audioMutedByDefault: true,
    defaultAudioVolume: 0.75,
    lockFullscreen: false,
  };
}

export function loadAdvancedSettings(scaleIds: string[]): AdvancedSettings {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return getDefaultAdvancedSettings();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AdvancedSettings>;

    return normalizeAdvancedSettings(parsed, scaleIds);
  } catch {
    return getDefaultAdvancedSettings();
  }
}

export function saveAdvancedSettings(
  settings: Partial<AdvancedSettings>,
  scaleIds: string[],
): AdvancedSettings {
  const normalized = normalizeAdvancedSettings(settings, scaleIds);

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
        lockedScaleId: normalized.lockedScaleId,
        manifestSource: normalized.manifestSource,
        verboseLogging: normalized.verboseLogging,
        hiddenScaleIds: normalized.hiddenScaleIds,
        audioMutedByDefault: normalized.audioMutedByDefault,
        defaultAudioVolume: normalized.defaultAudioVolume,
        lockFullscreen: normalized.lockFullscreen,
      }),
  );

  return normalized;
}

export function normalizeAdvancedSettings(
  settings: Partial<AdvancedSettings>,
  scaleIds: string[],
): AdvancedSettings {
  const defaults = getDefaultAdvancedSettings();
  const validScaleIds = new Set(scaleIds);
  const manifestSource = FORCED_MANIFEST_SOURCE ??
    (settings.manifestSource === 'online' || settings.manifestSource === 'local'
      ? settings.manifestSource
      : defaults.manifestSource);
  const lockedScaleId =
    typeof settings.lockedScaleId === 'string' && validScaleIds.has(settings.lockedScaleId)
      ? settings.lockedScaleId
      : null;
  const hiddenScaleIds = Array.isArray(settings.hiddenScaleIds)
    ? settings.hiddenScaleIds.filter(
        (scaleId, index, list): scaleId is string =>
          typeof scaleId === 'string' &&
          validScaleIds.has(scaleId) &&
          list.indexOf(scaleId) === index &&
          scaleId !== lockedScaleId,
      )
    : defaults.hiddenScaleIds;
  const defaultAudioVolume = normalizeVolume(
    typeof settings.defaultAudioVolume === 'number'
      ? settings.defaultAudioVolume
      : defaults.defaultAudioVolume,
  );

  if (!lockedScaleId && hiddenScaleIds.length >= scaleIds.length && scaleIds.length > 0) {
    hiddenScaleIds.pop();
  }

  return {
    lockedScaleId: FORCED_LOCKED_SCALE_ID ?? lockedScaleId,
    manifestSource,
    verboseLogging: Boolean(settings.verboseLogging),
    hiddenScaleIds,
    audioMutedByDefault: Boolean(settings.audioMutedByDefault),
    defaultAudioVolume,
    lockFullscreen: Boolean(settings.lockFullscreen),
  };
}

function normalizeVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return getDefaultAdvancedSettings().defaultAudioVolume;
  }

  return Math.max(0, Math.min(1, value));
}

export function getVisibleScaleIds(
  settings: AdvancedSettings,
  scaleIds: string[],
): string[] {
  if (settings.lockedScaleId) {
    return [settings.lockedScaleId];
  }

  const hidden = new Set(settings.hiddenScaleIds);
  const visible = scaleIds.filter((scaleId) => !hidden.has(scaleId));

  return visible.length > 0 ? visible : scaleIds.slice(0, 1);
}

function getForcedManifestSource(): ManifestSource | null {
  const value = import.meta.env.VITE_MANIFEST_SOURCE;

  return value === 'local' || value === 'online' ? value : null;
}

function getForcedLockedScaleId(): string | null {
  const value = import.meta.env.VITE_LOCKED_SCALE_ID;

  return typeof value === 'string' && value.length > 0 ? value : null;
}
