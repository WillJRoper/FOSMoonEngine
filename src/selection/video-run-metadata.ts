/**
 * Video-associated run metadata.
 *
 * Each video asset has a sidecar YAML file (same basename) providing final run
 * totals for the summary overlay and HUD.
 *
 * ── Why a sidecar? ──────────────────────────────────
 * The video generator embeds a .yaml next to every .mp4. This keeps each run's
 * achievements bundled with its media — no centralised database, no per-class
 * switch. The summary overlay and HUD both consume the same shape.
 */

import { parse } from 'yaml';
import { fetchWithOnlineAssetFallback } from '../shared/online-assets.ts';

export interface VideoRunMetadata {
  /** Simulation wall-clock time in seconds. */
  wallclockSeconds: number;
  /** Total compute consumed (core-hours). */
  computeUsed: number;
  /** Peak memory used during simulation (GB). */
  memoryUsed: number;
  /** Estimated carbon emissions (kgCO2e). */
  carbonBurnt: number;
  /** Number of particles that changed state during the run. */
  particlesUpdated: number;
  /** Input parameter values stored with the selected run when available. */
  parameterValues: Record<string, number>;
  /** Display-friendly metrics shown in the summary overlay. */
  summaryMetrics: Record<string, VideoRunSummaryMetric>;
}

export interface VideoRunSummaryMetric {
  label: string;
  value: string;
}

/**
 * Derive the sidecar metadata URL from a video URL.
 *
 * The video generator writes every .mp4 with a same-named .yaml beside it, so
 * we just swap the extension. The regex handles both plain URLs and ones that
 * already carry a query string (the `$|\?` branch).
 *
 * @param videoUrl - URL ending in `.mp4`.
 * @returns URL for the YAML sidecar (same basename).
 */
export function getVideoMetadataUrl(videoUrl: string): string {
  // Replace the trailing .mp4 with .yaml, preserving any query string.
  return videoUrl.replace(/\.mp4($|\?)/, '.yaml$1');
}

/**
 * Load and parse a video sidecar metadata file.
 *
 * Returns null when the file is missing, malformed, or missing required fields.
 *
 * @param url - Metadata URL (usually from `getVideoMetadataUrl`).
 * @returns Parsed metadata, or `null` when missing/invalid.
 */
export async function loadVideoRunMetadata(
  url: string,
): Promise<VideoRunMetadata | null> {
  try {
    // Fetch the sidecar YAML.  A 404 is not an error — many placeholders won't
    // have one yet — so we return null and let the caller degrade gracefully.
    const response = await fetchWithOnlineAssetFallback(url);

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    const raw = parse(text) as Partial<Record<keyof VideoRunMetadata, unknown>>;

    // Extract the five required numeric fields.  Each one goes through
    // `toNumber` which accepts both number and string YAML values.
    const wallclockSeconds = toNumber(raw.wallclockSeconds);
    const computeUsed = toNumber(raw.computeUsed);
    const memoryUsed = toNumber(raw.memoryUsed);
    const carbonBurnt = toNumber(raw.carbonBurnt);
    const particlesUpdated = toNumber(raw.particlesUpdated);
    const parameterValues = await loadRunParameterValues(url);
    const summaryMetrics = toSummaryMetrics(raw.summaryMetrics);

    // ── Guard: every required field must be present and finite ──────────
    // The summaryMetrics record is optional — if missing the summary overlay
    // will simply show nothing for the metric section.
    if (
      wallclockSeconds === null ||
      computeUsed === null ||
      memoryUsed === null ||
      carbonBurnt === null ||
      particlesUpdated === null
    ) {
      return null;
    }

    return {
      wallclockSeconds,
      computeUsed,
      memoryUsed,
      carbonBurnt,
      particlesUpdated,
      parameterValues,
      summaryMetrics,
    };
  } catch {
    // Network error, YAML parse error, or anything else — all treated as
    // "metadata not available" rather than crashing the UI.
    return null;
  }
}

async function loadRunParameterValues(url: string): Promise<Record<string, number>> {
  try {
    // Parameter values live in a sibling YAML file so the summary can display
    // both aggregate run metrics and the exact parameters saved with that run.
    const response = await fetchWithOnlineAssetFallback(getRunParametersUrl(url));

    if (!response.ok) {
      return {};
    }

    const text = await response.text();
    const raw = parse(text) as Record<string, unknown>;

    return toNumberRecord(raw);
  } catch {
    return {};
  }
}

/**
 * Derive the sidecar parameter YAML URL from a run summary URL.
 */
function getRunParametersUrl(url: string): string {
  return url.replace(/run_summary\.yaml($|\?)/, 'parameters.yaml$1');
}

/**
 * Safer coerce-to-number that accepts both number and string YAML values.
 *
 * YAML parsers sometimes leave "1.23e4" as a string when the field isn't
 * explicitly typed. This helper normalises both paths without exploding on
 * undefined, null, or non-numeric garbage.
 *
 * @param value - Raw value (number, string, or anything else).
 * @returns Finite number or null when the value can't be interpreted.
 */
function toNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Safely unpack the free-form summaryMetrics block from YAML.
 *
 * The YAML author can name metrics anything (e.g. "totalEnergy", "virialRatio").
 * Each metric must have a `label` (human-readable string) and `value` (any
 * scalar — we stringify it for display). Malformed entries are silently skipped.
 *
 * @param value - Raw value from the parsed YAML (should be an object).
 * @returns Map of metric key → display-friendly label + value pair.
 */
function toSummaryMetrics(value: unknown): Record<string, VideoRunSummaryMetric> {
  if (!value || typeof value !== 'object') {
    // Absent or non-object means no metrics — not an error.
    return {};
  }

  const rawMetrics = value as Record<string, unknown>;
  const output: Record<string, VideoRunSummaryMetric> = {};

  for (const [key, rawMetric] of Object.entries(rawMetrics)) {
    // Skip entries that aren't objects (e.g. someone wrote a scalar by mistake).
    if (!rawMetric || typeof rawMetric !== 'object') {
      continue;
    }

    const metric = rawMetric as Record<string, unknown>;
    // Fall back to the YAML key when `label` is missing — better than showing
    // "undefined" in the summary UI.
    const label = typeof metric.label === 'string' ? metric.label : key;
    const rawValue = metric.value;

    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    output[key] = {
      label,
      value: String(rawValue),
    };
  }

  return output;
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const output: Record<string, number> = {};

  for (const [key, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const numeric = toNumber(rawEntry);

    if (numeric === null) {
      // Skip malformed entries rather than treating the whole sidecar as bad.
      continue;
    }

    output[key] = numeric;
  }

  return output;
}
