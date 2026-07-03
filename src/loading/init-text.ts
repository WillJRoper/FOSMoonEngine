/**
 * YAML-driven initialization text loader.
 *
 * Each simulation class owns a YAML file containing a flat list of candidate
 * lines. All lines are returned as a pool; the overlay randomly picks from
 * the pool at display time.
 */

import { parse } from 'yaml';
import type { SimulationClass } from '../selection/simulation-catalog.ts';

import planetaryRaw from './planetary.yaml?raw';

export interface InitializationLine {
  text: string;
}

const RAW_BY_CLASS: Record<SimulationClass['id'], string> = {
  planetary: planetaryRaw,
};

/**
 * Return every candidate line as a flat pool.
 *
 * Each YAML file is a simple list of strings. All are returned so the overlay
 * can randomly pick lines at display time, unbound by any ordering.
 *
 * @param simClass - Active simulation family.
 * @returns Full pool of candidate lines.
 */
export function getInitializationLines(
  simClass: SimulationClass,
): InitializationLine[] {
  const parsed = parse(RAW_BY_CLASS[simClass.id]) as string[];

  return parsed.map((text) => ({ text }));
}
