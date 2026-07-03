/**
 * Nearest-run asset resolution with placeholder fallbacks.
 *
 * Tries a generated run manifest (mapping parameter-space points to asset
 * bundles), then falls back to flat placeholder assets per simulation family.
 */

import type { SimParameter } from './simulation-catalog.ts';
import { findBestEntry } from './ngp_parameter_search.ts';
import { withBaseUrl } from '../shared/urls.ts';
import { getVideoMetadataUrl } from './video-run-metadata.ts';
import type { ManifestSource } from '../shared/advanced-settings.ts';
import { logInfo, logWarn } from '../shared/logger.ts';
import { fetchWithOnlineAssetFallback } from '../shared/online-assets.ts';
import { parse } from 'yaml';

export interface VideoMatch {
  url: string;
  liveDataUrl: string;
  summaryUrl: string;
  audioUrl?: string;
  views?: Record<string, string>;
  viewId?: string;
  runId?: string;
}

export interface GalleryHexCoordinate {
  q: number;
  r: number;
}

export interface GalleryManifestRun extends VideoMatch {
  runId: string;
  simulationId: string;
  label: string;
  parameters: Record<string, number>;
  thumbnailUrl: string | null;
  galleryHex: GalleryHexCoordinate | null;
}

interface RunManifest {
  version: number;
  primaryBase?: string;
  backupBase?: string;
  runs: RunManifestEntry[];
}

interface RunManifestEntry {
  simulationId: string;
  runId: string;
  parameters?: Record<string, number>;
  label?: string;
  thumbnailPath?: string;
  liveDataPath: string;
  summaryPath: string;
  audioPath?: string;
  defaultView?: string;
  views: Record<string, string>;
}

export interface ManifestController {
  getSource: () => ManifestSource;
  setSource: (source: ManifestSource) => void;
  preloadActiveManifest: () => Promise<void>;
  listRuns: (simClassId: string) => Promise<GalleryManifestRun[]>;
  getRunById: (simClassId: string, runId: string) => Promise<GalleryManifestRun | null>;
  findNearestVideo: (
    simClassId: string,
    params: SimParameter[],
    values: Record<string, number>,
  ) => Promise<VideoMatch>;
}

let manifestPromise: Promise<RunManifest> | null = null;

function loadLocalManifest(): Promise<RunManifest> {
  if (manifestPromise) return manifestPromise;

  manifestPromise = fetch(withBaseUrl('assets/local-manifest.json'), { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load manifest: assets/local-manifest.json`);
      }

      logInfo('Loaded local manifest');

      return (await response.json()) as RunManifest;
    })
    .catch((error) => {
      manifestPromise = null;

      logWarn('Manifest unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });

      return { version: 1, runs: [] };
    });

  return manifestPromise;
}

export function createManifestController(
  _initialSource?: ManifestSource,
): ManifestController {
  const manifestPromise = loadLocalManifest();

  return {
    getSource() {
      return 'local' as ManifestSource;
    },
    setSource(_nextSource) {
      logInfo('Manifest source change ignored — local only');
    },
    async preloadActiveManifest() {
      await manifestPromise;
    },
    async listRuns(simClassId) {
      return listManifestRuns(manifestPromise, simClassId);
    },
    async getRunById(simClassId, runId) {
      const runs = await listManifestRuns(manifestPromise, simClassId);

      return runs.find((run) => run.runId === runId) ?? null;
    },
    async findNearestVideo(simClassId, params, values) {
      const manifestMatch = await findManifestBackedRun(
        manifestPromise,
        simClassId,
        params,
        values,
      );

      if (manifestMatch) {
        return manifestMatch;
      }

      const fallbackUrl = getLocalPlaceholderVideo(simClassId);

      logWarn('Falling back to placeholder assets', {
        simClassId,
        fallbackUrl,
      });

      return {
        url: fallbackUrl,
        liveDataUrl: getLocalPlaceholderStats(simClassId),
        summaryUrl: getVideoMetadataUrl(fallbackUrl),
      };
    },
  };
}

async function listManifestRuns(
  manifestPromise: Promise<RunManifest>,
  simClassId: string,
): Promise<GalleryManifestRun[]> {
  const manifest = await manifestPromise;

  const runs = await Promise.all(
    manifest.runs
      .filter((entry) => entry.simulationId === simClassId)
      .map(toGalleryManifestRun),
  );

  return runs.filter((run): run is GalleryManifestRun => run !== null);
}

async function toGalleryManifestRun(
  entry: RunManifestEntry,
): Promise<GalleryManifestRun | null> {
  const viewId = entry.defaultView ?? Object.keys(entry.views)[0];
  const videoPath = bestEffortViewPath(entry.views, viewId);

  if (!viewId || !videoPath) {
    return null;
  }

  const summaryUrl = withBaseUrl(entry.summaryPath);

  return {
    url: withBaseUrl(videoPath),
    liveDataUrl: withBaseUrl(entry.liveDataPath),
    summaryUrl,
    audioUrl: entry.audioPath ? withBaseUrl(entry.audioPath) : undefined,
    viewId,
    runId: entry.runId,
    simulationId: entry.simulationId,
    label: entry.label ?? entry.runId,
    parameters: { ...(entry.parameters ?? {}) },
    thumbnailUrl: entry.thumbnailPath ? withBaseUrl(entry.thumbnailPath) : null,
    galleryHex: await loadRunGalleryHex(summaryUrl),
    views: Object.fromEntries(
      Object.entries(entry.views).map(([key, path]) => [key, withBaseUrl(path)]),
    ),
  };
}

async function loadRunGalleryHex(summaryUrl: string): Promise<GalleryHexCoordinate | null> {
  try {
    const response = await fetchWithOnlineAssetFallback(getRunGalleryHexUrl(summaryUrl));

    if (!response.ok) {
      return null;
    }

    const raw = parse(await response.text()) as Record<string, unknown>;
    const candidate =
      raw && typeof raw === 'object' && 'galleryHex' in raw
        ? raw.galleryHex
        : raw;

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const q = toFiniteInteger((candidate as Record<string, unknown>).q);
    const r = toFiniteInteger((candidate as Record<string, unknown>).r);

    return q === null || r === null ? null : { q, r };
  } catch {
    return null;
  }
}

function getRunGalleryHexUrl(summaryUrl: string): string {
  return summaryUrl.replace(/run_summary\.yaml($|\?)/, 'hex_pos.yaml$1');
}

function toFiniteInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);

  return Number.isInteger(numeric) ? numeric : null;
}

/**
 * Resolve the local placeholder video for a simulation family.
 *
 * @param simClassId - Simulation family id.
 * @returns Local asset URL.
 */
export function getLocalPlaceholderVideo(_simClassId: string): string {
  return withBaseUrl('assets/planet_test.mp4');
}

/**
 * Resolve the local placeholder live-stat CSV for a simulation family.
 *
 * @param simClassId - Simulation family id.
 * @returns Local asset URL.
 */
export function getLocalPlaceholderStats(_simClassId: string): string {
  return withBaseUrl('assets/planet_test_planetary_stats.csv');
}

/**
 * Brute-force nearest-neighbor search over the generated manifest.
 * This picks the closest precomputed run for playback only; scoring remains
 * based on the user's chosen slider values elsewhere in the app.
 *
 * @param simClassId - Simulation family id.
 * @param params - Parameter definitions for normalization.
 * @param values - Active user-selected parameter values.
 * @returns Matched run bundle or `null` when unavailable.
 */
async function findManifestBackedRun(
  manifestPromise: Promise<RunManifest>,
  simClassId: string,
  params: SimParameter[],
  values: Record<string, number>,
): Promise<VideoMatch | null> {
  const manifest = await manifestPromise;
  const runs = manifest.runs.filter((entry) => entry.simulationId === simClassId);

  if (runs.length === 0) {
    logWarn('No manifest runs found for simulation', { simClassId });

    return null;
  }

  const best = findBestEntry(runs, params, values) as RunManifestEntry | null;

  if (!best) {
    return null;
  }

  const viewId = best.defaultView ?? Object.keys(best.views)[0];
  const videoPath = bestEffortViewPath(best.views, viewId);

  if (!viewId || !videoPath) {
    return null;
  }

  logInfo('Selected manifest-backed run', {
    simClassId,
    runId: best.runId,
    selectedValues: values,
    viewId,
  });

  return {
    url: withBaseUrl(videoPath),
    liveDataUrl: withBaseUrl(best.liveDataPath),
    summaryUrl: withBaseUrl(best.summaryPath),
    audioUrl: best.audioPath ? withBaseUrl(best.audioPath) : undefined,
    viewId,
    runId: best.runId,
    views: Object.fromEntries(
      Object.entries(best.views).map(([key, path]) => [
        key,
        withBaseUrl(path),
      ]),
    ),
  };
}

function bestEffortViewPath(
  views: Record<string, string>,
  viewId: string | undefined,
): string | undefined {
  return viewId ? views[viewId] : undefined;
}

/**
 * Normalized distance between active parameter values and one manifest entry.
 *
 * Each parameter is normalized to its own range (0..1). Final distance is
 * the mean across all parameters. 0 = perfect match.
 *
 * This is a thin wrapper around the shared implementation in ngp_parameter_search.ts.
 *
 * @param entry - Manifest run entry.
 * @param params - Parameter definitions.
 * @param values - Current user values.
 * @returns Mean normalized distance (lower is better).
 */
