/**
 * Simulation class definitions loaded from YAML.
 *
 * The config is split across YAML files so concerns stay separate:
 * - `simulation-catalog.yaml`   Family metadata (labels, scoring)
 * - `parameter-info.yaml`       Parameter ranges and descriptions
 * - `../summaries/summary-stats-config.yaml`  Summary overlay stat config
 * - `../live-data/live-stats-config.yaml`     Live telemetry stat config
 */

import { parse } from 'yaml';
import catalogRaw from './simulation-catalog.yaml?raw';
import paramsRaw from './parameter-info.yaml?raw';
import summaryStatsRaw from '../summaries/summary-stats-config.yaml?raw';
import liveStatsRaw from '../live-data/live-stats-config.yaml?raw';
import { withBaseUrl } from '../shared/urls.ts';

export interface SimParameter {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Internal midpoint fallback used when no explicit value is available. */
  fallbackValue: number;
  description?: string;
  valueScale?: number;
  displayUnit?: string;
  displayFormat?: 'fixed' | 'scientific' | 'compact' | 'qualitative';
  displaySignificantFigures?: number;
  /** When true the slider thumb moves on a log10 scale. */
  logScale?: boolean;
  /** Ordered qualitative labels shown instead of numeric values on the slider. */
  qualiLabels?: string[];
  /** When false, this parameter is deprioritised in nearest-run matching. */
  primary?: boolean;
}

export interface MorphologyChecklistItem {
  id: string;
  label: string;
  description?: string;
  hint?: string;
}

export interface SimulationMetadata {
  results: ResultDisplayConfig[];
  summaryStats: StatDisplayConfig[];
  liveStats: StatDisplayConfig[];
  morphologyChecklist?: MorphologyChecklistItem[];
}

export interface ResultDisplayConfig extends StatDisplayConfig {
  target: number;
}

export interface SimulationViewOption {
  id: string;
  label?: string;
  icon?: string;
  audio?: boolean;
  description?: string;
}

export interface StatDisplayConfig {
  id: StatDisplayId;
  label?: string;
  section?: string;
  value?: string;
  unit?: string;
  description?: string;
  live?: boolean;
  liveKey?: string;
  fromVideo?: boolean;
  videoKey?: string;
  scaleWithTime?: boolean;
  integer?: boolean;
  valueScale?: number;
  displayFormat?: 'integer' | 'float' | 'scientific' | 'compact' | 'qualitative';
  precision?: number;
}

export type SummaryStatId =
  | 'scale'
  | 'parameters'
  | 'runtime'
  | 'similarityScore'
  | 'bestFitDelta'
  | 'carbonBurnt'
  | 'computeUsed'
  | 'memoryUsed'
  | 'particlesUpdated'
  | 'audioTrack'
  | 'terminalLines';

export type StatDisplayId = SummaryStatId | string;

export interface SimulationClass {
  id: string;
  label: string;
  placeholderImage: string;
  parameterSubtitle?: string;
  metadata: SimulationMetadata;
  parameters: SimParameter[];
  views: SimulationViewOption[];
}

// ── Raw YAML shapes ────────────────────────────────────────────────────────

interface RawCatalogEntry {
  label: string;
  placeholderImage: string;
  parameterSubtitle?: string;
  views?: RawSimulationViewOption[];
}

interface RawParameterConfig {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  description?: string;
  value_scale?: number;
  display_unit?: string;
  display_format?: 'fixed' | 'scientific' | 'compact' | 'qualitative';
  display_significant_figures?: number;
  log_scale?: boolean;
  quali_labels?: string[];
  primary?: boolean;
}

interface RawStatsConfig {
  summaryStats: RawStatDisplayConfig[];
  liveStats: RawStatDisplayConfig[];
}

interface RawSummaryConfig {
  resources?: RawStatDisplayConfig[];
  results?: RawResultDisplayConfig[];
  simulationStats?: RawStatDisplayConfig[];
  similarityScore?: { value: string };
  morphologyChecklist?: MorphologyChecklistItem[];
}

interface RawResultDisplayConfig extends RawStatDisplayConfig {
  target: number;
}

interface RawSimulationViewOption {
  id: string;
  label?: string;
  icon?: string;
  audio?: boolean;
  description?: string;
}

interface RawStatDisplayConfig {
  id: StatDisplayId;
  label?: string;
  section?: string;
  value?: string;
  unit?: string;
  description?: string;
  live?: boolean;
  live_key?: string;
  from_video?: boolean;
  video_key?: string;
  scale_with_time?: boolean;
  integer?: boolean;
  value_scale?: number;
  display_format?: 'integer' | 'float' | 'scientific' | 'compact' | 'qualitative';
  precision?: number;
}

// ── Load and merge ─────────────────────────────────────────────────────────

type FamilyId = string;

const catalog = parse(catalogRaw) as Record<FamilyId, RawCatalogEntry>;
const paramsByFamily = parse(paramsRaw) as Record<
  FamilyId,
  Record<string, RawParameterConfig>
>;
const summaryStatsByFamily = parse(summaryStatsRaw) as Record<
  FamilyId,
  RawSummaryConfig
>;
const liveStatsByFamily = parse(liveStatsRaw) as Record<FamilyId, RawStatsConfig>;

export const SIMULATION_CLASSES: SimulationClass[] = Object.entries(catalog).map(
  ([id, entry]) => {
    const summaryStats = flattenSummaryConfig(summaryStatsByFamily[id]);
    const results = (summaryStatsByFamily[id]?.results ?? []).map(normalizeResultConfig);
    const liveStats = liveStatsByFamily[id]?.liveStats ?? [];
    const rawParams = paramsByFamily[id] ?? {};

    return {
      id,
      label: entry.label,
      placeholderImage: withBaseUrl(entry.placeholderImage),
      parameterSubtitle: entry.parameterSubtitle,
      metadata: {
        results,
        summaryStats: summaryStats.map(normalizeStatConfig),
        liveStats: liveStats.map(normalizeStatConfig),
        morphologyChecklist: summaryStatsByFamily[id]?.morphologyChecklist,
      },
      parameters: Object.entries(rawParams).map(([parameterId, parameter]) => {
        const quali = parameter.quali_labels;
        const isQualitative = quali !== undefined && quali.length > 0;

        const resolvedMin = isQualitative ? 0 : parameter.min;
        const resolvedMax = isQualitative ? quali!.length - 1 : parameter.max;
        const step = isQualitative
          ? 1
          : (parameter.step ?? inferParameterStep(parameter.min, parameter.max));
        const fallbackValue = isQualitative
          ? Math.floor(quali!.length / 2)
          : (parameter.log_scale
              ? Math.sqrt(parameter.min * parameter.max)
              : midpoint(parameter.min, parameter.max));

        return {
          id: parameterId,
          label: parameter.label,
          unit: parameter.unit ?? '',
          min: resolvedMin,
          max: resolvedMax,
          step,
          fallbackValue,
          description: parameter.description,
          valueScale: parameter.value_scale,
          displayUnit: parameter.display_unit,
          displayFormat: parameter.display_format,
          displaySignificantFigures: parameter.display_significant_figures,
          logScale: parameter.log_scale,
          qualiLabels: quali,
          primary: parameter.primary ?? true,
        };
      }),
      views: (entry.views ?? []).map((view) => ({
        id: view.id,
        label: view.label,
        icon: view.icon,
        audio: view.audio ?? false,
        description: view.description,
      })),
    };
  },
);

function flattenSummaryConfig(
  config: RawSummaryConfig | undefined,
): RawStatDisplayConfig[] {
  if (!config) {
    return [];
  }

  const stats: RawStatDisplayConfig[] = [];

  for (const stat of config.resources ?? []) {
    stats.push({ ...stat, section: 'resources' });
  }

  for (const stat of config.simulationStats ?? []) {
    stats.push({ ...stat, section: 'simulationStats' });
  }

  if (config.similarityScore) {
    stats.push({
      id: 'similarityScore',
      value: config.similarityScore.value,
    });
  }

  return stats;
}

function normalizeStatConfig(config: RawStatDisplayConfig): StatDisplayConfig {
  return {
    id: config.id,
    label: config.label,
    section: config.section,
    value: config.value,
    unit: config.unit,
    description: config.description,
    live: config.live ?? false,
    liveKey: config.live_key,
    fromVideo: config.from_video ?? false,
    videoKey: config.video_key,
    scaleWithTime: config.scale_with_time ?? false,
    integer: config.integer ?? false,
    valueScale: config.value_scale,
    displayFormat: config.display_format,
    precision: config.precision,
  };
}

function normalizeResultConfig(config: RawResultDisplayConfig): ResultDisplayConfig {
  return {
    ...normalizeStatConfig(config),
    target: config.target,
  };
}

function inferParameterStep(min: number, max: number): number {
  const range = Math.max(max - min, 1e-9);
  const target = range / 100;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;

  let bucket = 1;

  if (normalized <= 1) {
    bucket = 1;
  } else if (normalized <= 2) {
    bucket = 2;
  } else if (normalized <= 5) {
    bucket = 5;
  } else {
    bucket = 10;
  }

  return bucket * magnitude;
}

function midpoint(min: number, max: number): number {
  return min + (max - min) / 2;
}
