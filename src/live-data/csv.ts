import { fetchWithOnlineAssetFallback } from '../shared/online-assets.ts';

/**
 * Live-stat CSV loading and sampling.
 *
 * The app stores live telemetry in timestamped CSV files. This module is
 * responsible for loading those CSV files, parsing them into frames, and
 * sampling/interpolating values for the current playback time.
 */

export interface LiveStatsFrame {
  t: number;
  values: Record<string, string>;
}

export interface LiveStatsDataset {
  mode: 'time' | 'row';
  frames: LiveStatsFrame[];
}

export const EMPTY_LIVE_STATS_DATASET: LiveStatsDataset = {
  mode: 'time',
  frames: [],
};

/**
 * Fetch and parse a live-stat CSV file.
 *
 * @param url - URL to fetch.
 * @returns Parsed frame list.
 */
export async function loadLiveStatsCsv(url: string): Promise<LiveStatsDataset> {
  // Treat a missing CSV as a hard failure here; the shell decides whether to
  // catch that and substitute an empty dataset for display purposes.
  const response = await fetchWithOnlineAssetFallback(url);

  if (!response.ok) {
    throw new Error(`Failed to load live stats CSV: ${url}`);
  }

  const text = await response.text();

  return parseCsv(text);
}

/**
 * Sample the loaded frames at the requested playback time.
 *
 * @param dataset - Parsed live-stat dataset.
 * @param timeSeconds - Playback timestamp in seconds.
 * @param durationSeconds - Full video duration (for row-based datasets).
 * @returns Key/value map suitable for UI display.
 */
export function sampleLiveStats(
  dataset: LiveStatsDataset,
  timeSeconds: number,
  durationSeconds = 0,
): Record<string, string> {
  // Row-based datasets don't have timestamps — we sample by normalized position instead.
  if (dataset.mode === 'row') {
    return sampleRowBasedStats(dataset.frames, timeSeconds, durationSeconds);
  }

  // Time-based datasets: find the two neighboring keyframes and interpolate.
  const frames = dataset.frames;

  if (frames.length === 0) {
    return {};
  }

  // Before or at the first frame? Return the first frame's values.
  if (timeSeconds <= frames[0].t) {
    return { ...frames[0].values };
  }

  // After or at the last frame? Return the last frame's values.
  const lastFrame = frames[frames.length - 1];

  if (timeSeconds >= lastFrame.t) {
    return { ...lastFrame.values };
  }

  const upperIndex = findFirstFrameIndexAfterTime(frames, timeSeconds);
  const start = frames[Math.max(0, upperIndex - 1)];
  const end = frames[Math.min(frames.length - 1, upperIndex)];

  // Compute the interpolation fraction and lerp between the two frames.
  const fraction = (timeSeconds - start.t) / Math.max(end.t - start.t, 1e-9);

  return interpolateFrameValues(start.values, end.values, fraction);
}

function findFirstFrameIndexAfterTime(
  frames: LiveStatsFrame[],
  timeSeconds: number,
): number {
  let low = 1;
  let high = frames.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (frames[middle].t <= timeSeconds) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

/**
 * Convert raw CSV text into timestamped frames.
 *
 * @param text - Raw CSV payload.
 * @returns Parsed frame list.
 */
function parseCsv(text: string): LiveStatsDataset {
  // Trim and drop empty lines so small formatting differences in generated CSVs
  // do not change parsing behavior.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return EMPTY_LIVE_STATS_DATASET;
  }

  const headers = splitCsvLine(lines[0]);

  // If the first column is "t", this is a time-keyed dataset where each row
  // has a timestamp and we interpolate between rows during playback.
  if (headers[0] === 't') {
    return {
      mode: 'time',
      frames: lines.slice(1).map((line) => {
        const cells = splitCsvLine(line);
        const values: Record<string, string> = {};

        // Column 0 is the timestamp; every remaining column becomes a named
        // metric value on this frame.
        for (let index = 1; index < headers.length; index += 1) {
          values[headers[index]] = cells[index] ?? '';
        }

        return {
          t: parseFloat(cells[0] ?? '0') || 0,
          values,
        };
      }),
    };
  }

  // Otherwise this is a row-based dataset (no timestamp column). We treat each
  // row as one discrete frame indexed by its position in the file.
  return {
    mode: 'row',
    frames: lines.slice(1).map((line, rowIndex) => {
      const cells = splitCsvLine(line);
      const values: Record<string, string> = {};

      // Row-based files have no explicit time column, so every header maps
      // directly to its cell value.
      for (let index = 0; index < headers.length; index += 1) {
        values[headers[index]] = cells[index] ?? '';
      }

      return {
        t: rowIndex,
        values,
      };
    }),
  };
}

/**
 * Sample a row-per-frame dataset by normalized playback position.
 *
 * @param frames - Parsed frame rows.
 * @param timeSeconds - Playback timestamp in seconds.
 * @param durationSeconds - Full video duration.
 * @returns Key/value map from the nearest row.
 */
function sampleRowBasedStats(
  frames: LiveStatsFrame[],
  timeSeconds: number,
  durationSeconds: number,
): Record<string, string> {
  if (frames.length === 0) {
    return {};
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ...frames[0].values };
  }

  // Convert absolute playback time into a normalized file position, then snap
  // to the nearest row because row-based datasets are discrete rather than interpolated.
  const fraction = Math.max(0, Math.min(1, timeSeconds / durationSeconds));
  const index = Math.round(fraction * (frames.length - 1));

  return { ...frames[index].values };
}

/**
 * Split one CSV line while respecting simple quoted cells.
 *
 * @param line - Raw CSV line.
 * @returns Array of cells.
 */
function splitCsvLine(line: string): string[] {
  // This is intentionally a small CSV splitter, not a full RFC parser. It is
  // enough for the generated telemetry files used by this app.
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  cells.push(current);

  return cells;
}

/**
 * Interpolate one frame of values between two neighboring keyframes.
 *
 * Numeric values are linearly interpolated (lerp). Non-numeric values snap to
 * the nearest keyframe — they jump at the halfway point rather than blending
 * into nonsense strings like "galaxgalaxy".
 *
 * @param start - Values at the start keyframe.
 * @param end - Values at the end keyframe.
 * @param fraction - Normalized interpolation fraction 0..1.
 * @returns Interpolated value map (union of all keys from both frames).
 */
function interpolateFrameValues(
  start: Record<string, string>,
  end: Record<string, string>,
  fraction: number,
): Record<string, string> {
  // Collect all unique keys from both frames so nothing gets dropped.
  const keys = new Set([...Object.keys(start), ...Object.keys(end)]);
  const output: Record<string, string> = {};

  for (const key of keys) {
    const startValue = start[key] ?? '';
    const endValue = end[key] ?? startValue;
    const startNumber = parseFloat(startValue);
    const endNumber = parseFloat(endValue);

    if (Number.isFinite(startNumber) && Number.isFinite(endNumber)) {
      // Numeric interpolation: lerp between the two values.
      const value = startNumber + (endNumber - startNumber) * fraction;

      output[key] = formatNumber(value);
      continue;
    }

    // Non-numeric: snap at the midpoint to avoid blended strings.
    output[key] = fraction < 0.5 ? startValue : endValue;
  }

  return output;
}

/**
 * Format an interpolated number for display.
 *
 * We keep two decimal places internally but strip trailing zeros so "42.00"
 * becomes "42" and "3.50" becomes "3.5". This keeps the HUD compact while
 * preserving enough precision for gradual live counters.
 *
 * @param value - Numeric value to format.
 * @returns Display-friendly string.
 */
function formatNumber(value: number): string {
  return (
    value
      .toFixed(2)
      // Strip trailing zeros after the decimal: "12.50" → "12.5", "7.00" → "7"
      .replace(/\.0+$|(?<=\..*?)0+$/g, '')
      // Strip a trailing decimal point if all decimals were zeros: "7." → "7"
      .replace(/\.$/, '')
  );
}
