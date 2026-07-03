/**
 * Nearest-grid-point parameter-space search.
 *
 * This module provides a two-stage nearest-run lookup that can prioritise
 * certain user-selected parameters over others when the available simulation
 * runs do not form a complete Cartesian grid.
 *
 * ## Problem
 *
 * When a user picks a slider combo that has no matching precomputed run,
 * a naive nearest-neighbour search can return a run that is unexpectedly
 * far from the user's intent on a dimension they consider important.
 * For example, a planetary-impact user who selects a head-on (0°) collision
 * might be shown a 20° run because a velocity-optimised search happened
 * to find a closer angle+velocity bundle elsewhere.
 *
 * ## Two-stage search
 *
 * Parameters are tagged with ``primary: true | false`` in the YAML config.
 *
 * 1. **Primary stage** — find every run that is closest on the primary axes.
 * 2. **Refinement stage** — among those candidates, pick the run closest on
 *    non-primary parameters only.
 *
 * When every parameter is primary the algorithm degrades to a single-pass
 * Euclidean search, which is identical to the original behaviour.
 *
 * ## Exports
 *
 * - ``findBestEntry`` — public entry point; orchestrates the search.
 * - ``getEntryDistance`` — compute the mean normalised distance between a
 *   single candidate and the user's input.  Accepts an optional ``useParams``
 *   set to restrict which parameters contribute to the score.
 *
 * ## Precedence rules
 *
 * Each parameter contributes equally within its own normalised range
 * (0 = exact match, 1 = worst possible).  The final distance is the
 * arithmetic mean across participating parameters, so families with
 * different numbers of parameters produce comparable scores.
 */

import type { SimParameter } from './simulation-catalog.ts';

/** Minimum contract a run entry must satisfy to participate in the search. */
export interface ParameterSearchEntry {
  parameters?: Record<string, number>;
}

/**
 * Compute the mean normalised distance between *entry* and *values*.
 *
 * Each parameter's contribution is ``|selected - candidate| / range``,
 * clamped to ``[0, 1]``.  When ``useParams`` is supplied only the named
 * ids contribute; otherwise every known parameter is used.
 *
 * @param entry    - Candidate run entry.
 * @param params   - Parameter schemas (used for range normalisation).
 * @param values   - User-selected parameter values.
 * @param useParams - Optional subset of parameter ids to score against.
 * @returns Mean normalised distance (0 = perfect match).
 */
export function getEntryDistance(
  entry: ParameterSearchEntry,
  params: SimParameter[],
  values: Record<string, number>,
  useParams?: Set<string>,
): number {
  if (params.length === 0) {
    return 0;
  }

  const filtered = useParams
    ? params.filter((parameter) => useParams.has(parameter.id))
    : params;

  if (filtered.length === 0) {
    return 0;
  }

  const total = filtered.reduce((sum, parameter) => {
    const selected = values[parameter.id] ?? parameter.fallbackValue;
    const candidate = entry.parameters?.[parameter.id] ?? parameter.fallbackValue;
    const range = Math.max(parameter.max - parameter.min, 1e-9);

    return sum + Math.abs(selected - candidate) / range;
  }, 0);

  return total / filtered.length;
}

/**
 * Find the run entry closest to *values* using a two-stage search.
 *
 * When at least one parameter has ``primary: false`` the search first
 * narrows to runs that are equally close on primary parameters only,
 * then picks the best among them on non-primary parameters only.  When every
 * parameter is primary the search is a single-pass Euclidean scan.
 *
 * @param runs   - Available run entries.
 * @param params - Parameter schemas.
 * @param values - User-selected parameter values.
 * @returns The best-matching entry, or null when the list is empty.
 */
export function findBestEntry(
  runs: ParameterSearchEntry[],
  params: SimParameter[],
  values: Record<string, number>,
): ParameterSearchEntry | null {
  if (runs.length === 0) {
    return null;
  }

  const primaryIds = new Set(
    params.filter((p) => p.primary !== false).map((p) => p.id),
  );
  const secondaryIds = new Set(
    params.filter((p) => p.primary === false).map((p) => p.id),
  );
  const hasNonPrimary = params.some((p) => p.primary === false);

  // Single-stage search when every parameter is primary.
  if (!hasNonPrimary) {
    return findClosest(runs, params, values);
  }

  // Two-stage: find the best primary-axis distance first, then refine
  // among all candidates that are within a tiny tolerance of that best
  // primary distance.
  const bestPrimary = findClosest(runs, params, values, primaryIds);

  if (!bestPrimary) {
    return null;
  }

  const bestPrimaryDistance = getEntryDistance(
    bestPrimary,
    params,
    values,
    primaryIds,
  );

  // Tolerance avoids excluding runs with identical primary-axis scores
  // due to floating-point noise.
  const primaryTolerance = 1e-6;
  const candidates = runs.filter((entry) => {
    const distance = getEntryDistance(entry, params, values, primaryIds);

    return Math.abs(distance - bestPrimaryDistance) <= primaryTolerance;
  });

  // Among the candidates that are equally good on primary axes,
  // pick the one closest on non-primary axes only.
  return findClosest(candidates, params, values, secondaryIds);
}

/**
 * Linear scan that returns the entry with the smallest normalised distance.
 */
function findClosest(
  runs: ParameterSearchEntry[],
  params: SimParameter[],
  values: Record<string, number>,
  useParams?: Set<string>,
): ParameterSearchEntry | null {
  if (runs.length === 0) {
    return null;
  }

  let bestEntry = runs[0];
  let bestDistance = getEntryDistance(bestEntry, params, values, useParams);

  for (const entry of runs.slice(1)) {
    const distance = getEntryDistance(entry, params, values, useParams);

    if (distance < bestDistance) {
      bestEntry = entry;
      bestDistance = distance;
    }
  }

  return bestEntry;
}
