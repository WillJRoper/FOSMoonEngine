/**
 * Telemetry HUD (display-mode live stats panel).
 *
 * The telemetry panel shows a small list of metrics in the top-right corner of
 * display mode. Metrics can come from three sources:
 * - the active simulation parameters (static values from the config overlay)
 * - "summary" metadata fields (e.g. scale, parameter count)
 * - live-stream values (sampled from a CSV stream at the current playback time)
 */
import type {
  SimulationClass,
  StatDisplayConfig,
  SummaryStatId,
} from '../selection/simulation-catalog.ts';
import { formatCompactNumber, formatMaybeNumber, formatParameterValue, withUnit } from '../shared/format.ts';

export interface TelemetryPanelController {
  /** Render metric rows for the active simulation and its current values. */
  update: (
    simClass: SimulationClass,
    values: Record<string, number>,
    liveValues?: Record<string, string>,
  ) => void;
}

/**
 * Create and mount the telemetry HUD panel.
 *
 * @param container - Host element to mount into.
 * @returns Controller for updating visible metrics.
 */
export function createTelemetryPanel(container: HTMLElement): TelemetryPanelController {
  // Outer card element shown in the top-right of display mode.
  const panel = document.createElement('aside');

  panel.className = 'data-panel';

  // Metric rows are rebuilt whenever the active class or values change.
  const metricList = document.createElement('div');

  metricList.className = 'data-panel__metrics';

  panel.appendChild(metricList);
  container.appendChild(panel);

  return {
    update(
      simClass: SimulationClass,
      values: Record<string, number>,
      liveValues: Record<string, string> = {},
    ) {
      // Rebuild the list from scratch. This is simple and perfectly fine for the
      // very small amount of data shown in this panel (typically < 15 rows).
      metricList.innerHTML = '';

      const availableMetrics = buildAvailableMetrics(simClass, values, liveValues);

      // Walk the YAML-configured liveStats list in order and render each row.
      for (const stat of simClass.metadata.liveStats) {
        const metric = selectMetric(stat, availableMetrics);
        const row = document.createElement('div');

        row.className = 'data-panel__metric';
        row.innerHTML = `
          <span class="data-panel__metric-label">${metric.label}</span>
          <span class="data-panel__metric-value">${metric.value}</span>
        `;
        metricList.appendChild(row);
      }
    },
  };
}

/**
 * Build a dictionary of candidate metrics keyed by id.
 *
 * Metrics come from three sources:
 * 1. Static parameter values (current slider positions)
 * 2. Derived "named" metrics (app-defined fields like scale or parameter count)
 * 3. Live-streamed CSV values (sampled at the current playback position)
 *
 * The three sources are merged with live values taking priority, so a CSV
 * column named "scale" would override the static scale metric.
 *
 * @param simClass - Active simulation family.
 * @param values - Active parameter values.
 * @param liveValues - Sampled live values keyed by CSV column.
 * @returns Metric map keyed by metric id.
 */
function buildAvailableMetrics(
  simClass: SimulationClass,
  values: Record<string, number>,
  liveValues: Record<string, string>,
): Record<string, { label: string; value: string }> {
  // Source 1: Parameter metrics — always available because they're part of the
  // class definition and the user has slider values for them.
  const parameterMetrics = Object.fromEntries(
    simClass.parameters.map((parameter) => [
      parameter.id,
      {
        label: parameter.label,
        value:
          parameter.displayFormat === 'qualitative' && parameter.qualiLabels
            ? parameter.qualiLabels[
                Math.round(values[parameter.id] ?? parameter.fallbackValue)
              ] ?? '--'
            : formatParameterValue(
                values[parameter.id] ?? parameter.fallbackValue,
                parameter.step,
                {
                  scale: parameter.valueScale,
                  format: parameter.displayFormat,
                  significantFigures: parameter.displaySignificantFigures,
                },
              ),
      },
    ]),
  ) as Record<string, { label: string; value: string }>;

  // Source 2: "Named" metrics are app-defined summary fields that are not
  // parameters — things like "Scale" and "Parameters".
  const namedMetrics: Partial<Record<SummaryStatId, { label: string; value: string }>> =
    {
      scale: { label: 'Scale', value: simClass.label },
      parameters: { label: 'Parameters', value: String(simClass.parameters.length) },
    };

  // Source 3: Live CSV values — these override anything from sources 1 and 2
  // because they're the most current data available.
  return {
    ...parameterMetrics,
    ...namedMetrics,
    ...Object.fromEntries(
      Object.entries(liveValues).map(([key, value]) => [
        key,
        { label: humanizeKey(key), value },
      ]),
    ),
  };
}

/**
 * Convert a camelCase/snake_case-ish key into spaced words.
 *
 * CSV column names like "particlesUpdated" become "particles Updated" and
 * "dark_matter_density" becomes "dark matter density". This is good enough
 * for auto-generated labels without maintaining a label map in YAML.
 *
 * @param key - Raw metric id (camelCase or snake_case).
 * @returns Human-friendly label string.
 */
function humanizeKey(key: string): string {
  // Replace underscores with spaces, then insert spaces before uppercase letters.
  return key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Resolve one metric value and label from the available sources.
 *
 * Selection priority:
 * 1. A sampled live value keyed by `stat.liveKey` (or `stat.id`)
 * 2. The static parameter/named metric from `availableMetrics`
 * 3. A fallback "--" placeholder
 *
 * @param stat - Display configuration for this metric row.
 * @param availableMetrics - All known metrics keyed by id.
 * @returns Resolved label/value pair for rendering.
 */
function selectMetric(
  stat: StatDisplayConfig,
  availableMetrics: Record<string, { label: string; value: string }>,
): { label: string; value: string } {
  const metric = availableMetrics[stat.id] ?? { label: stat.id, value: '--' };

  const liveKey = stat.liveKey ?? stat.id;
  const liveMetric = availableMetrics[liveKey];

  const resolvedValue = formatMetricValue(
    liveMetric?.value ?? metric.value ?? '--',
    stat,
    Boolean(liveMetric),
  );

  return {
    label: stat.label ?? liveMetric?.label ?? metric.label,
    value: withUnit(resolvedValue, stat.unit),
  };
}

/**
 * Apply optional numeric scaling/rounding to a resolved stat value.
 *
 * Live numeric values are formatted compactly (k / M / B suffixes) so the
 * HUD panel stays readable and stable. Static placeholder strings pass
 * through unchanged.
 */
function formatMetricValue(
  value: string,
  stat: StatDisplayConfig,
  shouldFormat: boolean,
): string {
  if (value === '--') {
    return value;
  }

  const numeric = Number(value);

  // Pass through non-numeric strings unchanged.
  if (!Number.isFinite(numeric)) {
    return value;
  }

  const scale = stat.valueScale ?? 1;
  const scaled = numeric * scale;

  if (typeof stat.precision === 'number' && !stat.integer) {
    return scaled.toFixed(Math.max(0, stat.precision));
  }

  // Live-updating values always use compact formatting first — even
  // integer-configured stats like particle counts benefit from it when
  // streaming (e.g. "1.2M" instead of "1,234,567").
  if (shouldFormat) {
    return stat.integer
      ? formatCompactNumber(Math.round(scaled))
      : formatLiveMetricNumber(scaled);
  }

  // Non-live integer-configured stats use locale-grouped digits.
  if (stat.integer) {
    return Math.max(0, Math.round(scaled)).toLocaleString(undefined);
  }

  // Static parameter values keep their step-aligned precision.
  return formatMaybeNumber(value, { integer: stat.integer });
}

function formatLiveMetricNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';

  if (abs < 1_000) {
    return value.toFixed(2);
  }

  if (abs < 1_000_000) {
    return `${sign}${(abs / 1_000).toFixed(2)}k`;
  }

  if (abs < 1_000_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  }

  if (abs < 1_000_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  }

  return `${sign}${(abs / 1_000_000_000_000).toFixed(2)}T`;
}
