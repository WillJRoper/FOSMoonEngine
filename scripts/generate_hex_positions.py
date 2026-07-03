#!/usr/bin/env python3
"""Generate per-run ``hex_pos.yaml`` files from manifest order.

The gallery used to rely on implicit fallback positions from run order. This
script freezes those positions into per-run sidecars so each run can be moved by
editing its own asset directory instead of the central manifest.
"""

from __future__ import annotations

import heapq
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "public" / "assets" / "local-manifest.json"
def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    runs = manifest.get("runs", [])
    coordinates = balanced_coordinates(len(runs))

    for index, run in enumerate(runs):
        summary_path = run.get("summaryPath")
        run_id = run.get("runId")
        if not isinstance(summary_path, str) or not isinstance(run_id, str):
            continue

        q, r = coordinates[index]
        output_path = REPO_ROOT / "public" / summary_path
        output_path = output_path.parent / "hex_pos.yaml"
        output_path.write_text(f"q: {q}\nr: {r}\n", encoding="utf-8")


def balanced_coordinates(count: int) -> list[tuple[int, int]]:
    if count <= 0:
        return []

    coordinates = [(0, 0)]
    radius = 1

    while len(coordinates) < count:
        ring = ring_coordinates(radius)
        remaining = count - len(coordinates)

        if remaining >= len(ring):
            coordinates.extend(ring)
        else:
            order = balanced_ring_indices(len(ring))
            coordinates.extend(ring[index] for index in order[:remaining])

        radius += 1

    return coordinates


def ring_coordinates(radius: int) -> list[tuple[int, int]]:
    directions = ((1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1))
    q = 0
    r = -radius
    coordinates: list[tuple[int, int]] = []

    for dq, dr in directions:
        for _ in range(radius):
            coordinates.append((q, r))
            q += dq
            r += dr

    return coordinates


def balanced_ring_indices(size: int) -> list[int]:
    if size <= 0:
        return []

    order = [0]
    segments: list[tuple[int, int, int, int]] = [(-size, 0, 0, 0)]
    tie_break = 1

    while segments and len(order) < size:
        neg_steps, _, start, end = heapq.heappop(segments)
        steps = -neg_steps

        if steps <= 1:
            continue

        midpoint = (start + steps // 2) % size
        order.append(midpoint)

        left_steps = steps // 2
        right_steps = steps - steps // 2

        if left_steps > 1:
            heapq.heappush(segments, (-left_steps, tie_break, start, midpoint))
            tie_break += 1

        if right_steps > 1:
            heapq.heappush(segments, (-right_steps, tie_break, midpoint, end))
            tie_break += 1

    return order


if __name__ == "__main__":
    main()
