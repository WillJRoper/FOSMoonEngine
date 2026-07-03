/**
 * Gallery progress persistence.
 *
 * Tracks which manifest-backed runs have been completed for each simulation
 * family. Progress is local-only so the gallery can light up completed nodes
 * without depending on any backend state.
 */

const STORAGE_KEY_PREFIX = 'moon-engine-gallery-progress:';

interface GalleryProgressRecord {
  completedRunIds: string[];
}

/** Return the completed run ids for one simulation family. */
export function getCompletedGalleryRunIds(simulationId: string): string[] {
  return loadRecord(simulationId).completedRunIds;
}

/** Check whether one run is currently lit in the gallery. */
export function isGalleryRunCompleted(simulationId: string, runId: string): boolean {
  return loadRecord(simulationId).completedRunIds.includes(runId);
}

/**
 * Mark a run as completed and reset the cycle once every known run has been lit.
 */
export function markGalleryRunCompleted(
  simulationId: string,
  runId: string,
  allRunIds: string[],
): string[] {
  const current = new Set(loadRecord(simulationId).completedRunIds);

  current.add(runId);

  const knownRunIds = allRunIds.filter((entry) => entry.length > 0);

  if (knownRunIds.length > 0 && knownRunIds.every((entry) => current.has(entry))) {
    saveRecord(simulationId, { completedRunIds: [] });

    return [];
  }

  const completedRunIds = Array.from(current).sort();

  saveRecord(simulationId, { completedRunIds });

  return completedRunIds;
}

/** Clear saved gallery progress for one simulation family. */
export function resetGalleryProgress(simulationId: string): void {
  localStorage.removeItem(getStorageKey(simulationId));
}

function loadRecord(simulationId: string): GalleryProgressRecord {
  try {
    const raw = localStorage.getItem(getStorageKey(simulationId));

    if (!raw) {
      return { completedRunIds: [] };
    }

    const parsed = JSON.parse(raw) as Partial<GalleryProgressRecord>;
    const completedRunIds = Array.isArray(parsed.completedRunIds)
      ? parsed.completedRunIds.filter((entry): entry is string => typeof entry === 'string')
      : [];

    return { completedRunIds };
  } catch {
    return { completedRunIds: [] };
  }
}

function saveRecord(simulationId: string, record: GalleryProgressRecord): void {
  localStorage.setItem(getStorageKey(simulationId), JSON.stringify(record));
}

function getStorageKey(simulationId: string): string {
  return `${STORAGE_KEY_PREFIX}${simulationId}`;
}
