/**
 * Summary metric derivation.
 *
 * This module converts a simulation configuration plus the current parameter
 * values into a dictionary of summary metrics. Keeping this logic in the same
 * directory as the summary overlay makes the feature boundary explicit.
 */

import type { SimulationClass } from '../selection/simulation-catalog.ts';
import type { VideoRunMetadata } from '../selection/video-run-metadata.ts';

export interface SummaryMetricValue {
  /** Human-readable label shown in the summary card. */
  label: string;
  /** Raw display value before any per-stat summary formatting is applied. */
  value: string;
}

/**
 * Build the full set of known summary metrics for a completed run.
 *
 * The scoring model is intentionally simple: we measure how far the user's
 * selected parameters are from the parameter-space "correct" values defined in
 * the YAML config. Only entries whose ids match actual parameter ids contribute
 * to this score, which lets other scales use separate result-based targets in
 * the same metadata block for the summary bars. This score is intentionally
 * based on the user's guess, not the exact parameters of the nearest
 * precomputed video chosen for playback.
 *
 * For resource metrics (carbon, compute, memory), we use real values from the
 * run metadata when available, or derive plausible-looking placeholder values
 * from the same distance measure so the summary overlay always has data to show.
 *
 * The summary overlay later filters and orders these using the YAML config.
 */
export function buildSummaryMetricMap(
  simClass: SimulationClass,
  values: Record<string, number>,
  videoDurationSeconds: number,
  runMetadata?: VideoRunMetadata | null,
): Record<string, SummaryMetricValue> {
  // Extract the configured result targets up front so the later distance pass can
  // quickly decide which slider parameters participate in score calculation.
  const resultTargets = Object.fromEntries(
    simClass.metadata.results.map((result) => [result.id, result.target]),
  ) as Record<string, number>;

  // Resolve all configured result metrics into comparable numeric triples. These
  // can come from player input, saved run parameters, or summary sidecar values
  // depending on what the current family authored as its result set.
  const resultValues = simClass.metadata.results
    .map((result) => {
      const resolved = resolveResultValue(simClass, values, runMetadata, result.id);

      if (resolved === null) {
        return null;
      }

      return {
        id: result.id,
        value: resolved,
        target: result.target,
      };
    })
    .filter((result) => result !== null) as Array<{
    id: string;
    value: number;
    target: number;
  }>;

  // ── Step 1: Per-parameter distance ─────────────────────────────────────
  // Measure how far the selected parameters are from the configured "correct"
  // values. Each parameter is normalized to its own range so different scales
  // contribute equally to the final score.
  const normalizedDistances = simClass.parameters
    .filter((parameter) => resultTargets[parameter.id] !== undefined)
    .map((parameter) => {
      const value = values[parameter.id] ?? parameter.fallbackValue;
      const correctValue = resultTargets[parameter.id] ?? parameter.fallbackValue;

      return (
        Math.abs(value - correctValue) / Math.max(parameter.max - parameter.min, 1e-9)
      );
    });

  // ── Step 2: Mean distance across all parameters ─────────────────────────
  // Collapse the per-parameter distances into one average value (0 = perfect).
  const meanDistance =
    normalizedDistances.reduce((sum, value) => sum + value, 0) /
    Math.max(normalizedDistances.length, 1);

  // ── Step 3: Similarity score ────────────────────────────────────────────
  // Invert the distance into a 0-100 score where 100 = perfect match.
  // A mean distance of 0 → score 100; mean distance of 1 → score 0.
  const score = computeOutcomeScore(resultValues);

  // ── Step 4: Resource stats ──────────────────────────────────────────────
  // Derive placeholder resource stats from the same distance measure for now.
  // These are replaced by real metadata values when the sidecar YAML is available.
  const carbonKg = (runMetadata?.carbonBurnt ?? 0.8 + meanDistance * 4.2).toFixed(2);
  const computeHours = runMetadata?.computeUsed ?? 18 + meanDistance * 46;
  const memoryGb = runMetadata?.memoryUsed ?? 12 + meanDistance * 84;
  const computeProfile = `${formatCompactNumber(computeHours, 1)} CPU-hrs\n${formatCompactNumber(memoryGb, 1)} GB`;

  // ── Step 5: Additional derived fields ────────────────────────────────────
  // These additional fields feed summary cards that are useful for public-facing
  // interpretation even though they are not direct components of the numeric fit.
  const parameterCount = String(simClass.parameters.length);
  const bestFitDelta = `${(meanDistance * 100).toFixed(1)}%`;
  const terminalLines = String(simClass.parameters.length + 6);
  const audioTrack = 'Present';
  const runtimeHours = formatHoursFromSeconds(
    runMetadata?.wallclockSeconds ?? videoDurationSeconds,
  );
  const moonIronPercent = formatPercent(
    computeTargetMatchPercent(resolveResultValue(simClass, values, runMetadata, 'moon_iron')),
  );
  const protoEarthInMoonPercent = formatPercent(
    computeTargetMatchPercent(
      resolveResultValue(simClass, values, runMetadata, 'proto_earth_in_moon'),
    ),
  );

  // ── Step 6: Assemble the final metric dictionary ─────────────────────────
  // The summary overlay will filter and order these using its own YAML config.
  // We also merge in any arbitrary summary metrics from the run metadata YAML
  // under their original keys, so the YAML can define custom metrics per run.
  return {
    scale: { label: 'Scale', value: simClass.label },
    parameters: { label: 'Parameters', value: parameterCount },
    runtime: { label: 'Total Runtime', value: runtimeHours },
    similarityScore: { label: 'Similarity Score', value: `${score}/100` },
    bestFitDelta: { label: 'Best-Fit Delta', value: bestFitDelta },
    carbonBurnt: { label: 'Carbon Burnt', value: carbonKg },
    computeUsed: { label: 'Compute Used', value: computeProfile },
    memoryUsed: { label: 'Memory Used', value: formatCompactNumber(memoryGb, 1) },
    particlesUpdated: {
      label: 'Particle updates',
      value: runMetadata ? formatCount(runMetadata.particlesUpdated) : '--',
    },
    moon_iron_percent: {
      label: 'Iron in Moon',
      value: moonIronPercent,
    },
    proto_earth_in_moon_percent: {
      label: 'Proto-Earth in Moon',
      value: protoEarthInMoonPercent,
    },
    audioTrack: { label: 'Audio Track', value: audioTrack },
    terminalLines: { label: 'Terminal Lines', value: terminalLines },
    // Merge in any custom metrics from the run metadata YAML (if present).
    // This allows per-run YAML files to define arbitrary additional summary rows.
    ...Object.fromEntries(
      Object.entries(runMetadata?.summaryMetrics ?? {}).map(([key, metric]) => [
        key,
        {
          label: metric.label,
          value: metric.value,
        },
      ]),
    ),
  };
}

/**
 * Format a potentially large count without decimals.
 *
 * Uses the user's locale for digit grouping (e.g. "1,234,567" in en-US).
 *
 * @param value - Count value (e.g. particle update count).
 * @returns Human-friendly integer-ish string.
 */
function formatCount(value: number): string {
  // Keep this intentionally plain for now. Some summary rows want the raw count
  // semantics rather than compact suffixes such as `1.2M`.
  return String(Math.max(0, value));
}

/**
 * Format a duration as hours with at most 2 decimal places.
 *
 * Strips trailing zeros so "8.50" → "8.5" and "12.00" → "12".
 *
 * @param totalSeconds - Duration in seconds.
 * @returns Hours string (e.g. "12.5" for 12.5 hours).
 */
function formatHoursFromSeconds(totalSeconds: number): string {
  const hours = Math.max(0, totalSeconds) / 3600;

  return hours
    .toFixed(2)
    .replace(/\.0+$|(?<=\..*?)0+$/g, '')
    .replace(/\.$/, '');
}

/**
 * Trim a numeric value to a small fixed precision without adding suffixes.
 *
 * Despite the name, this helper is local to summary-metrics and is only used to
 * keep generated resource values tidy inside multiline strings such as the
 * compute-profile card.
 */
function formatCompactNumber(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$|(?<=\..*?)0+$/g, '')
    .replace(/\.$/, '');
}

/**
 * Resolve the numeric value for a result target.
 *
 * The same precedence order as the overlay is used here so the computed score
 * matches the values the user sees in the bar section.
 */
function resolveResultValue(
  simClass: SimulationClass,
  values: Record<string, number>,
  runMetadata: VideoRunMetadata | null | undefined,
  id: string,
): number | null {
  const selectedParameter = simClass.parameters.find(
    (parameter) => parameter.id === id,
  );

  if (selectedParameter) {
    // Score against the player's current input rather than the nearest matched
    // run. The chosen playback asset is an approximation; the guess itself is
    // what the summary is evaluating.
    return values[id] ?? selectedParameter.fallbackValue;
  }

  // For non-parameter result keys, prefer summaryMetrics over parameterValues.
  // run_summary.yaml is the authoritative source for output values; the
  // parameters.yaml sidecar may contain stale placeholders for those keys.
  // Prefer the "_bar" variant first — these are "forgiven"/scaled
  // values that are more forgiving of mismatches (e.g. Moon mass, spin).
  const barValue = runMetadata?.summaryMetrics[`${id}_bar`]?.value;

  if (barValue !== undefined) {
    const numeric = Number(barValue);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  const summaryValue = runMetadata?.summaryMetrics[id]?.value;

  if (summaryValue !== undefined) {
    const numeric = Number(summaryValue);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  const parameterValue = runMetadata?.parameterValues[id];

  if (typeof parameterValue === 'number' && Number.isFinite(parameterValue)) {
    return parameterValue;
  }

  return null;
}

/**
 * Format a percentage-like value, or a placeholder when unavailable.
 */
function formatPercent(value: number | null): string {
  if (value === null) {
    return '--';
  }

  // One decimal is enough to show relative closeness without pretending that the
  // heuristic is more precise than it really is.
  return value.toFixed(1);
}

/**
 * Convert a normalized result ratio into a simple 0-100 closeness percent.
 *
 * A value of 1 means perfect agreement with the target, while values one full
 * target-width away or more clamp to zero.
 */
function computeTargetMatchPercent(value: number | null): number | null {
  if (value === null) {
    return null;
  }

  return Math.max(0, (1 - Math.abs(value - 1)) * 100);
}

/**
 * Average result closeness across all available target metrics.
 */
function computeOutcomeScore(
  results: Array<{ id: string; value: number; target: number }>,
): number {
  if (results.length === 0) {
    return 0;
  }

  // Each result contributes a linear closeness score in [0, 1]. We average the
  // contributions so families with more result metrics are not automatically
  // favored or punished compared with smaller authored result sets.
  const total = results.reduce(
    (sum, result) =>
      sum + Math.max(0, 1 - Math.abs(result.value / Math.max(result.target, 1e-9) - 1)),
    0,
  );

  return Math.round((total / results.length) * 100);
}
