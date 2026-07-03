#!/usr/bin/env python3
"""Translate planetary run summaries into runtime metadata YAML.

Legacy planetary assets currently ship a config-shaped ``run_summary.yaml`` that
looks like the authored contents of ``src/summaries/summary-stats-config.yaml``.
The frontend instead expects each run directory to contain a runtime metadata
payload with resource totals plus an optional ``summaryMetrics`` mapping.

This script rewrites per-run files in-place.

When a local ``timesteps.txt`` is present, resource totals are derived from its
per-step wall-clock table instead of the legacy summary config values.

Usage::

    python3 scripts/translate_planetary_run_summaries.py
    python3 scripts/translate_planetary_run_summaries.py /path/to/planetary-runs
    python3 scripts/translate_planetary_run_summaries.py --dry-run
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLANETARY_ROOT = REPO_ROOT / "public" / "assets" / "planetary"
DEFAULT_THREADS_PER_RUN = 16
NODE_CORES = 256
NODE_MEMORY_GB = 1540.0
COSMA7_NODE_POWER_KW = 0.175
FACILITY_OVERHEAD_MULTIPLIER = 489.0 / 341.0
NORTH_EAST_GRID_CARBON_KG_PER_KWH = 43.1 / 1000.0

RESOURCE_IDS = frozenset(
    {
        "runtime",
        "carbonBurnt",
        "computeUsed",
        "memoryUsed",
        "particlesUpdated",
        "similarityScore",
    }
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory",
        nargs="?",
        type=Path,
        default=PLANETARY_ROOT,
        help="Directory containing per-run planetary subdirectories.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which files would be rewritten without modifying them.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    planetary_root = args.directory.expanduser().resolve()

    if not planetary_root.is_dir():
        raise SystemExit(f"ERROR: directory does not exist: {planetary_root}")

    converted = 0
    skipped = 0

    for run_dir in sorted(path for path in planetary_root.iterdir() if path.is_dir()):
        summary_path = run_dir / "run_summary.yaml"
        if not summary_path.exists():
            print(f"  [skip] {display_path(run_dir)} - missing run_summary.yaml")
            skipped += 1
            continue

        payload = load_yaml(summary_path)
        translated = translate_summary(payload, run_dir / "timesteps.txt")
        if translated is None:
            print(f"  [skip] {display_path(summary_path)} - unrecognised legacy format")
            skipped += 1
            continue

        if args.dry_run:
            print(f"  [dry-run] would write {display_path(summary_path)}")
        else:
            summary_path.write_text(
                yaml.safe_dump(translated, sort_keys=False),
                encoding="utf-8",
            )
            print(f"  wrote {display_path(summary_path)}")
        converted += 1

    print(f"converted={converted} skipped={skipped}")


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return raw if isinstance(raw, dict) else {}


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def is_runtime_metadata(payload: dict[str, Any]) -> bool:
    required_keys = {
        "wallclockSeconds",
        "computeUsed",
        "memoryUsed",
        "carbonBurnt",
        "particlesUpdated",
    }
    return required_keys.issubset(payload.keys())


def translate_summary(payload: dict[str, Any], timesteps_path: Path) -> dict[str, Any] | None:
    summary_metrics = extract_summary_metrics(payload)
    if not summary_metrics:
        return None

    resource_metrics = load_timesteps_resource_metrics(timesteps_path)
    if resource_metrics is None:
        resource_metrics = extract_resource_metrics_from_summary(payload)

    return {
        **resource_metrics,
        "summaryMetrics": summary_metrics,
    }


def extract_summary_metrics(payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    runtime_metrics = payload.get("summaryMetrics")
    if isinstance(runtime_metrics, dict):
        normalized: dict[str, dict[str, str]] = {}
        for key, metric in runtime_metrics.items():
            if not isinstance(metric, dict):
                continue
            value = metric.get("value")
            if value is None:
                continue
            normalized[str(key)] = {
                "label": str(metric.get("label") or key),
                "value": str(value),
            }
        if normalized:
            return normalized

    stats = extract_legacy_summary_stats(payload)
    summary_metrics: dict[str, dict[str, str]] = {}
    for stat_id, stat in stats.items():
        if stat_id in RESOURCE_IDS:
            continue

        value = stat.get("value")
        if value is None:
            continue

        label = stat.get("label") or stat_id
        summary_metrics[stat_id] = {
            "label": str(label),
            "value": str(value),
        }

    return summary_metrics


def extract_resource_metrics_from_summary(payload: dict[str, Any]) -> dict[str, Any]:
    if is_runtime_metadata(payload):
        return {
            "wallclockSeconds": to_int(payload.get("wallclockSeconds")),
            "computeUsed": to_float(payload.get("computeUsed")),
            "memoryUsed": to_float(payload.get("memoryUsed")),
            "carbonBurnt": to_float(payload.get("carbonBurnt")),
            "particlesUpdated": to_int(payload.get("particlesUpdated")),
        }

    stats = extract_legacy_summary_stats(payload)
    runtime_value = stats.get("runtime", {}).get("value")
    runtime_unit = stats.get("runtime", {}).get("unit")
    return {
        "wallclockSeconds": to_seconds(runtime_value, runtime_unit),
        "computeUsed": to_float(stats.get("computeUsed", {}).get("value")),
        "memoryUsed": to_float(stats.get("memoryUsed", {}).get("value")),
        "carbonBurnt": to_float(stats.get("carbonBurnt", {}).get("value")),
        "particlesUpdated": to_int(stats.get("particlesUpdated", {}).get("value")),
    }


def load_timesteps_resource_metrics(timesteps_path: Path) -> dict[str, Any] | None:
    if not timesteps_path.is_file():
        return None

    total_wallclock_ms = 0.0
    total_dead_ms = 0.0
    total_g_updates = 0
    threads = DEFAULT_THREADS_PER_RUN

    with timesteps_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("# Number of threads:"):
                threads = max(1, to_int(line.split(":", 1)[1].strip()))
                continue
            if line.startswith("#"):
                continue

            fields = line.split()
            if len(fields) < 14:
                continue

            try:
                total_g_updates += int(fields[7])
                total_wallclock_ms += float(fields[12])
                total_dead_ms += float(fields[14])
            except ValueError:
                continue

    if total_wallclock_ms <= 0 and total_dead_ms <= 0:
        return None

    wallclock_seconds = (total_wallclock_ms + total_dead_ms) / 1000.0
    compute_used = round(wallclock_seconds * threads / 3600.0, 2)
    memory_used = round(NODE_MEMORY_GB * threads / NODE_CORES, 2)
    carbon_burnt = round(compute_used * carbon_kg_per_core_hour(), 6)

    return {
        "wallclockSeconds": int(round(wallclock_seconds)),
        "computeUsed": compute_used,
        "memoryUsed": memory_used,
        "carbonBurnt": carbon_burnt,
        "particlesUpdated": total_g_updates,
    }


def extract_legacy_summary_stats(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if "summaryStats" in payload and isinstance(payload["summaryStats"], list):
        return index_summary_stats(payload["summaryStats"])

    for value in payload.values():
        if not isinstance(value, dict):
            continue
        summary_stats = value.get("summaryStats")
        if isinstance(summary_stats, list):
            return index_summary_stats(summary_stats)

    return {}


def index_summary_stats(summary_stats: list[Any]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}

    for item in summary_stats:
        if not isinstance(item, dict):
            continue
        stat_id = item.get("id")
        if not isinstance(stat_id, str) or not stat_id:
            continue
        indexed[stat_id] = item

    return indexed


def to_seconds(value: Any, unit: Any) -> int:
    numeric = to_float(value)
    normalized_unit = str(unit or "seconds").strip().lower()

    if normalized_unit in {"day", "days"}:
        factor = 86400
    elif normalized_unit in {"hour", "hours"}:
        factor = 3600
    elif normalized_unit in {"minute", "minutes", "min", "mins"}:
        factor = 60
    else:
        factor = 1

    return int(round(numeric * factor))


def to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def to_int(value: Any) -> int:
    return int(round(to_float(value)))


def carbon_kg_per_core_hour() -> float:
    effective_node_power_kw = COSMA7_NODE_POWER_KW * FACILITY_OVERHEAD_MULTIPLIER
    return effective_node_power_kw * NORTH_EAST_GRID_CARBON_KG_PER_KWH / NODE_CORES


if __name__ == "__main__":
    main()
