/**
 * Gallery hex layout helpers.
 *
 * Nodes can optionally ship authored axial hex coordinates from the manifest.
 * When they do not, we assign deterministic fallback coordinates so the gallery
 * remains stable before curated positions or final artwork exist.
 */

import type { GalleryHexCoordinate } from '../selection/placeholder-assets.ts';

export interface HexLayoutNode {
  q: number;
  r: number;
  x: number;
  y: number;
}

/** Convert axial coordinates into flat-top hex pixel positions. */
export function axialToPixel(
  coordinate: GalleryHexCoordinate,
  hexWidth: number,
  hexHeight: number,
): { x: number; y: number } {
  return {
    x: coordinate.q * (hexWidth * 0.75),
    y: (coordinate.r + coordinate.q * 0.5) * hexHeight,
  };
}

/**
 * Resolve one pixel position per run using authored coordinates when available.
 */
export function buildHexLayout(
  coordinates: Array<GalleryHexCoordinate | null>,
  hexWidth: number,
  hexHeight: number,
): HexLayoutNode[] {
  const occupied = new Set<string>();
  const spiral = createSpiralCoordinateGenerator();

  return coordinates.map((coordinate) => {
    const resolvedCoordinate = coordinate ?? getNextFallbackCoordinate(occupied, spiral);
    const pixel = axialToPixel(resolvedCoordinate, hexWidth, hexHeight);

    occupied.add(toCoordinateKey(resolvedCoordinate));

    return {
      q: resolvedCoordinate.q,
      r: resolvedCoordinate.r,
      x: pixel.x,
      y: pixel.y,
    };
  });
}

function getNextFallbackCoordinate(
  occupied: Set<string>,
  spiral: Generator<GalleryHexCoordinate>,
): GalleryHexCoordinate {
  while (true) {
    const next = spiral.next();

    if (next.done) {
      return { q: 0, r: 0 };
    }

    if (!occupied.has(toCoordinateKey(next.value))) {
      return next.value;
    }
  }
}

function* createSpiralCoordinateGenerator(): Generator<GalleryHexCoordinate> {
  yield { q: 0, r: 0 };

  const directions: GalleryHexCoordinate[] = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];

  for (let radius = 1; ; radius += 1) {
    let coordinate = scaleCoordinate(directions[4], radius);

    for (const direction of directions) {
      for (let step = 0; step < radius; step += 1) {
        yield coordinate;
        coordinate = addCoordinates(coordinate, direction);
      }
    }
  }
}

function addCoordinates(
  left: GalleryHexCoordinate,
  right: GalleryHexCoordinate,
): GalleryHexCoordinate {
  return {
    q: left.q + right.q,
    r: left.r + right.r,
  };
}

function scaleCoordinate(
  coordinate: GalleryHexCoordinate,
  factor: number,
): GalleryHexCoordinate {
  return {
    q: coordinate.q * factor,
    r: coordinate.r * factor,
  };
}

function toCoordinateKey(coordinate: GalleryHexCoordinate): string {
  return `${coordinate.q},${coordinate.r}`;
}
