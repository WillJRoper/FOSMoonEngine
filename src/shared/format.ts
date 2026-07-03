/**
 * Shared formatting helpers.
 *
 * This module centralizes tiny formatting utilities that were previously copied
 * across several UI files. Keeping them here makes the display rules easier to
 * explain, easier to test later, and easier to update consistently.
 */

/**
 * Format a numeric value using the decimal precision implied by a parameter step.
 *
 * Example:
 * - step `0.1`   -> 1 decimal place
 * - step `0.01`  -> 2 decimal places
 * - step `1`     -> 0 decimal places
 *
 * @param value - Numeric value to format.
 * @param step - Step size that implies display precision.
 * @returns Formatted string.
 */
export function formatValueByStep(value: number, step: number): string {
  // Never show more than two decimal places in the UI. This keeps panels stable
  // as values update (especially for live stats) while still conveying precision.
  const decimals = Math.min(countDecimals(step), 2);

  return value.toFixed(decimals);
}

/**
 * Append a unit to a value string when one exists.
 *
 * This keeps units as a separate concern from the numeric/string value itself,
 * which matters now that values can come from config, derived summaries, or
 * future live streams.
 * @param value - Value string.
 * @param unit - Optional unit suffix.
 * @returns Value with unit when provided.
 */
export function withUnit(value: string, unit?: string): string {
  return unit ? `${value} ${unit}` : value;
}

/**
 * Format a number compactly using magnitude suffixes.
 *
 * Values are auto-scaled to their natural magnitude tier:
 *   < 1,000          → "123" (or "123.5" with one decimal)
 *   1,000 – 999,999  → "1.23k"
 *   1M – 999M        → "1.23M"
 *   1B – 999B        → "1.23B"
 *   ≥ 1T             → "1.23T" / "12.3T" / "1,230T" (stays in trillions)
 *
 * @param value - Numeric value.
 * @returns Compact display string.
 */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';

  if (!Number.isFinite(value)) {
    return String(value);
  }

  if (abs < 1_000) {
    return formatSmall(value);
  }

  if (abs < 1_000_000) {
    return `${sign}${formatSmall(value / 1_000)}k`;
  }

  if (abs < 1_000_000_000) {
    return `${sign}${formatSmall(value / 1_000_000)}M`;
  }

  if (abs < 1_000_000_000_000) {
    return `${sign}${formatSmall(value / 1_000_000_000)}B`;
  }

  // Beyond billions: scale in trillions. Numbers in this range are
  // intrinsically in the trillions so we keep the suffix and adjust
  // the mantissa for readability (up to one decimal).
  return `${sign}${formatSmall(value / 1_000_000_000_000)}T`;
}

/**
 * Format a small-ish number (typically after magnitude division) with up to
 * one decimal place, stripping trailing zeros.
 */
function formatSmall(value: number): string {
  return value
    .toFixed(1)
    .replace(/\.0+$|(?<=\..*?)0+$/g, '')
    .replace(/\.$/, '');
}

/**
 * Format a live numeric string compactly for UI display.
 *
 * @param raw - Raw value string.
 * @param options - Optional numeric transforms.
 * @returns Display-ready string.
 */
export function formatMaybeNumber(
  raw: string,
  options: { scale?: number; integer?: boolean } = {},
): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return raw;
  }

  const numeric = Number(trimmed);

  if (!Number.isFinite(numeric)) {
    return raw;
  }

  const scaled = numeric * (options.scale ?? 1);

  if (options.integer) {
    return Math.max(0, Math.round(scaled)).toLocaleString(undefined);
  }

  // Format to 2 decimal places, then strip trailing zeros (e.g. "12.50" → "12.5")
  // and any trailing decimal point (e.g. "12." → "12"). This keeps the display
  // clean without misleading precision.
  return scaled
    .toFixed(2)
    .replace(/\.0+$|(?<=\..*?)0+$/g, '')
    .replace(/\.$/, '');
}

/**
 * Format a numeric-looking string according to an explicit display mode.
 *
 * @param raw - Raw value string.
 * @param options - Formatting controls.
 * @returns Display-ready string.
 */
export function formatNumericString(
  raw: string,
  options: {
    scale?: number;
    mode?: 'integer' | 'float' | 'scientific' | 'compact';
    precision?: number;
  } = {},
): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return raw;
  }

  const numeric = Number(trimmed);

  if (!Number.isFinite(numeric)) {
    return raw;
  }

  const mode = options.mode ?? 'float';
  const scaled = numeric * (options.scale ?? 1);

  if (mode === 'integer') {
    return Math.round(scaled).toLocaleString(undefined);
  }

  if (mode === 'scientific' || mode === 'compact') {
    return formatCompactNumber(scaled);
  }

  const decimals = Math.max(0, options.precision ?? 2);

  return scaled
    .toFixed(decimals)
    .replace(/\.0+$|(?<=\..*?)0+$/g, '')
    .replace(/\.$/, '');
}

/**
 * Format a parameter value for display without changing the stored value.
 *
 * @param value - Raw parameter value.
 * @param step - Raw parameter step.
 * @param options - Optional display-only transforms.
 * @returns Formatted string.
 */
export function formatParameterValue(
  value: number,
  step: number,
  options: {
    scale?: number;
    format?: 'fixed' | 'scientific' | 'compact' | 'qualitative';
    significantFigures?: number;
  } = {},
): string {
  const scale = options.scale ?? 1;
  const scaledValue = value * scale;
  const scaledStep = step * scale;

  if (options.format === 'qualitative') {
    return String(Math.round(value));
  }

  if (options.format === 'compact' || options.format === 'scientific') {
    return formatCompactNumber(scaledValue);
  }

  return formatValueByStep(scaledValue, scaledStep);
}

/**
 * Count how many decimal places appear in a numeric step value.
 *
 * The result is used to keep displayed values aligned with the configured
 * precision of each simulation parameter.
 * @param step - Step value.
 * @returns Decimal count.
 */
export function countDecimals(step: number): number {
  const asString = String(step);
  const dotIndex = asString.indexOf('.');

  return dotIndex === -1 ? 0 : asString.length - dotIndex - 1;
}
