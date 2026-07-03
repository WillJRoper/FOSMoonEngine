/**
 * Gallery data shaping.
 *
 * This module keeps the view model for the gallery separate from manifest
 * loading and overlay rendering. That makes it easy to swap in real frame art
 * later without changing the overlay controller.
 */

import type { SimulationClass } from '../selection/simulation-catalog.ts';
import type { GalleryManifestRun } from '../selection/placeholder-assets.ts';
import { buildHexLayout } from './gallery-layout.ts';

const HEX_WIDTH = 208;
const HEX_HEIGHT = Math.round((HEX_WIDTH * Math.sqrt(3)) / 2);
const STAGE_MARGIN = 180;

export interface GalleryNode {
  runId: string;
  label: string;
  thumbnailUrl: string;
  summaryUrl: string;
  liveDataUrl: string;
  url: string;
  audioUrl?: string;
  viewId?: string;
  views?: Record<string, string>;
  parameters: Record<string, number>;
  q: number;
  r: number;
  revealOrder: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GalleryScene {
  nodes: GalleryNode[];
  stageWidth: number;
  stageHeight: number;
}

/** Build a placeholder-friendly gallery scene for one simulation family. */
export function buildGalleryScene(
  simClass: SimulationClass,
  runs: GalleryManifestRun[],
): GalleryScene {
  if (runs.length === 0) {
    return {
      nodes: [],
      stageWidth: HEX_WIDTH + STAGE_MARGIN * 2,
      stageHeight: HEX_HEIGHT + STAGE_MARGIN * 2,
    };
  }

  const layout = buildHexLayout(
    runs.map((run) => run.galleryHex),
    HEX_WIDTH,
    HEX_HEIGHT,
  );
  const minX = Math.min(...layout.map((entry) => entry.x));
  const minY = Math.min(...layout.map((entry) => entry.y));
  const nodes = runs.map((run, index) => ({
    runId: run.runId,
    label: run.label,
    thumbnailUrl: run.thumbnailUrl ?? simClass.placeholderImage,
    summaryUrl: run.summaryUrl,
    liveDataUrl: run.liveDataUrl,
    url: run.url,
    audioUrl: run.audioUrl,
    viewId: run.viewId,
    views: run.views,
    parameters: { ...run.parameters },
    q: layout[index].q,
    r: layout[index].r,
    revealOrder: index,
    x: layout[index].x - minX + STAGE_MARGIN,
    y: layout[index].y - minY + STAGE_MARGIN,
    width: HEX_WIDTH,
    height: HEX_HEIGHT,
  }));
  const stageWidth =
    Math.max(...nodes.map((node) => node.x + node.width)) + STAGE_MARGIN;
  const stageHeight =
    Math.max(...nodes.map((node) => node.y + node.height)) + STAGE_MARGIN;

  return { nodes, stageWidth, stageHeight };
}
