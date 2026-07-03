#!/usr/bin/env python3
"""Shared fake live-stat CSV generation helpers.

This module powers the tiny per-family wrapper scripts such as
``generate_galaxy_csv.py``. It reads the current split frontend config files,
probes an input video's duration, and writes a deterministic fake telemetry CSV
 containing:

* a ``t`` column with timestamps in seconds
* one column per configured live HUD stat, keyed by ``live_key`` or ``id``

The generated data is only for local placeholders and demos, so the goal is
repeatable, plausible-looking trends rather than physical accuracy.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import random
import subprocess
from pathlib import Path
from typing import Any, TypedDict, cast

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
PARAMETER_INFO_PATH = REPO_ROOT / "src" / "selection" / "parameter-info.yaml"
SIMULATION_CATALOG_PATH = REPO_ROOT / "src" / "selection" / "simulation-catalog.yaml"
LIVE_STATS_CONFIG_PATH = REPO_ROOT / "src" / "live-data" / "live-stats-config.yaml"


class RawParameterConfig(TypedDict, total=False):
    """YAML-backed parameter schema for one slider."""

    min: float
    max: float
    step: float
    value_scale: float


class RawLiveStatConfig(TypedDict, total=False):
    """YAML-backed live-stat display config for one HUD row."""

    id: str
    value: str | float | int
    live: bool
    live_key: str


class RawCatalogEntry(TypedDict):
    """Minimal family metadata loaded from ``simulation-catalog.yaml``."""

    metadata: dict[str, Any]


class FamilyConfig(TypedDict):
    """Merged config view consumed by the fake CSV generator."""

    parameters: dict[str, RawParameterConfig]
    correct_values: dict[str, float]
    live_stats: list[RawLiveStatConfig]


def build_arg_parser(simulation_id: str) -> argparse.ArgumentParser:
    """Create the CLI parser for one simulation family.

    Args:
        simulation_id: Simulation family id such as ``"cosmos"``.

    Returns:
        Configured argument parser.
    """
    parser = argparse.ArgumentParser(
        description=f"Generate fake {simulation_id} live-stat CSV from an MP4 duration.",
    )
    parser.add_argument("video", help="Path to the MP4 video file")
    parser.add_argument(
        "-o",
        "--output",
        help="Optional output CSV path (defaults next to the video)",
    )
    return parser


def run(simulation_id: str) -> None:
    """Run the fake CSV generator for one simulation family.

    Args:
        simulation_id: Simulation family id such as ``"galaxy"``.
    """
    args = build_arg_parser(simulation_id).parse_args()
    video_path = Path(args.video).expanduser().resolve()
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")

    config = load_family_config(simulation_id)
    duration_seconds = probe_duration_seconds(video_path)
    output_path = (
        Path(args.output).expanduser().resolve()
        if args.output
        else video_path.with_name(f"{video_path.stem}_{simulation_id}_stats.csv")
    )

    write_fake_csv(
        simulation_id=simulation_id,
        config=config,
        duration_seconds=duration_seconds,
        output_path=output_path,
        video_name=video_path.name,
    )
    print(output_path)


def load_family_config(simulation_id: str) -> FamilyConfig:
    """Load the split frontend config for one simulation family.

    Args:
        simulation_id: Simulation family id.

    Returns:
        Merged family config containing parameters, target values, and live-stat
        display rows.
    """
    parameter_data = load_yaml_file(PARAMETER_INFO_PATH)
    catalog_data = load_yaml_file(SIMULATION_CATALOG_PATH)
    live_stats_data = load_yaml_file(LIVE_STATS_CONFIG_PATH)

    if simulation_id not in parameter_data:
        raise SystemExit(
            f"Simulation type {simulation_id!r} not found in {PARAMETER_INFO_PATH}"
        )
    if simulation_id not in catalog_data:
        raise SystemExit(
            f"Simulation type {simulation_id!r} not found in {SIMULATION_CATALOG_PATH}"
        )
    if simulation_id not in live_stats_data:
        raise SystemExit(
            f"Simulation type {simulation_id!r} not found in {LIVE_STATS_CONFIG_PATH}"
        )

    family_catalog = cast(RawCatalogEntry, catalog_data[simulation_id])
    family_live_stats = cast(dict[str, Any], live_stats_data[simulation_id])

    return {
        "parameters": cast(dict[str, RawParameterConfig], parameter_data[simulation_id]),
        "correct_values": {
            str(key): float(value)
            for key, value in family_catalog.get("metadata", {})
            .get("correctValues", {})
            .items()
        },
        "live_stats": cast(
            list[RawLiveStatConfig], family_live_stats.get("liveStats", [])
        ),
    }


def load_yaml_file(path: Path) -> dict[str, Any]:
    """Load one YAML file as a dictionary.

    Args:
        path: YAML file path.

    Returns:
        Parsed YAML mapping.
    """
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}

    if not isinstance(data, dict):
        raise SystemExit(f"Expected a mapping in {path}")

    return cast(dict[str, Any], data)


def probe_duration_seconds(video_path: Path) -> float:
    """Read a video's duration using ``ffprobe``.

    Args:
        video_path: Path to the MP4 file.

    Returns:
        Duration in seconds, clamped to be non-negative.
    """
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    return max(float(result.stdout.strip()), 0.0)


def write_fake_csv(
    *,
    simulation_id: str,
    config: FamilyConfig,
    duration_seconds: float,
    output_path: Path,
    video_name: str,
) -> None:
    """Write a deterministic fake telemetry CSV.

    Args:
        simulation_id: Simulation family id.
        config: Merged family config.
        duration_seconds: Video duration in seconds.
        output_path: Destination CSV path.
        video_name: Video filename used for deterministic seeding.
    """
    live_stats = [stat for stat in config["live_stats"] if stat.get("live")]
    stream_keys = [stat.get("live_key") or stat["id"] for stat in live_stats]
    row_count = max(2, min(121, int(math.ceil(duration_seconds * 2)) + 1))
    times = [duration_seconds * i / (row_count - 1) for i in range(row_count)]

    seed_source = f"{simulation_id}:{video_name}:{duration_seconds:.3f}"
    rng = random.Random(hashlib.sha256(seed_source.encode("utf-8")).hexdigest())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["t", *stream_keys])
        writer.writeheader()

        for row_index, timestamp in enumerate(times):
            progress = 0.0 if duration_seconds <= 0 else timestamp / duration_seconds
            row = {"t": f"{timestamp:.3f}"}
            for stat in live_stats:
                stream_key = stat.get("live_key") or stat["id"]
                row[stream_key] = format_series_value(
                    generate_series_value(
                        simulation_id=simulation_id,
                        stat=stat,
                        config=config,
                        progress=progress,
                        rng=rng,
                        row_index=row_index,
                    )
                )
            writer.writerow(row)


def generate_series_value(
    *,
    simulation_id: str,
    stat: RawLiveStatConfig,
    config: FamilyConfig,
    progress: float,
    rng: random.Random,
    row_index: int,
) -> float:
    """Generate one numeric value for one stat at a progress point.

    Args:
        simulation_id: Simulation family id.
        stat: Live-stat config row.
        config: Merged family config.
        progress: Normalized playback progress in the range ``[0, 1]``.
        rng: Deterministically seeded random number generator.
        row_index: Current output row index.

    Returns:
        Generated numeric value.
    """
    stat_id = stat["id"]
    key = stat.get("live_key") or stat_id
    normalized_key = normalize_key(key)
    base_value = parse_float(stat.get("value"), default=0.0)
    parameters = config["parameters"]
    correct_values = config["correct_values"]

    if normalized_key == "age":
        max_age = 13.8 if simulation_id == "cosmos" else 12.6
        return max_age * progress

    if normalized_key == "redshift":
        start = 12.0 if simulation_id == "cosmos" else 4.0
        return max(start * (1.0 - progress), 0.0)

    if normalized_key == "stellar_size":
        stellar_mass = correct_values.get("stellar_mass", 5.0)
        final_size = 8.0 + stellar_mass * 3.5
        eased = 1.0 - (1.0 - progress) ** 2
        return final_size * eased

    if normalized_key == "time":
        return 48.0 * progress

    if normalized_key == "temperature":
        peak = 1800.0
        baseline = max(base_value, 280.0)
        return baseline + math.sin(progress * math.pi) * (peak - baseline)

    if normalized_key == "earth_mass":
        return 1.0 - 0.08 * math.sin(progress * math.pi * 0.5)

    if normalized_key == "similarity_score":
        distance = mean_normalized_distance(parameters, correct_values)
        base_score = max(0.0, (1.0 - distance) * 100.0)
        wobble = math.sin(progress * math.pi * 2.0) * 2.0
        return max(0.0, min(100.0, base_score + wobble))

    if stat_id in parameters:
        parameter = parameters[stat_id]
        start = midpoint(parameter)
        target = correct_values.get(stat_id, start)
        wobble = (
            math.sin(progress * math.pi * (row_index % 5 + 1))
            * 0.04
            * max(abs(target), 1.0)
        )
        return start + (target - start) * progress + wobble

    drift = math.sin(progress * math.pi * 2.0 + rng.random()) * max(
        base_value * 0.08, 0.2
    )
    return base_value + drift


def mean_normalized_distance(
    parameters: dict[str, RawParameterConfig], correct_values: dict[str, float]
) -> float:
    """Compute mean normalized distance between parameter midpoints and targets.

    Args:
        parameters: Mapping of parameter id to parameter schema.
        correct_values: Mapping of parameter id to target value.

    Returns:
        Mean normalized absolute distance.
    """
    distances: list[float] = []
    for parameter_id, parameter in parameters.items():
        baseline = midpoint(parameter)
        correct = float(correct_values.get(parameter_id, baseline))
        minimum = float(parameter.get("min", baseline))
        maximum = float(parameter.get("max", baseline))
        scale = max(maximum - minimum, 1e-9)
        distances.append(abs(baseline - correct) / scale)

    if not distances:
        return 0.0

    return sum(distances) / len(distances)


def midpoint(parameter: RawParameterConfig) -> float:
    """Return the midpoint fallback for one parameter schema.

    Args:
        parameter: Parameter schema mapping.

    Returns:
        Midpoint between ``min`` and ``max``.
    """
    minimum = float(parameter.get("min", 0.0))
    maximum = float(parameter.get("max", minimum))
    return minimum + (maximum - minimum) / 2.0


def parse_float(raw_value: Any, default: float) -> float:
    """Parse an arbitrary value as ``float``.

    Args:
        raw_value: Raw value from config or YAML.
        default: Fallback value when parsing fails.

    Returns:
        Parsed float when possible, otherwise ``default``.
    """
    if raw_value is None:
        return default
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return default


def format_series_value(value: float) -> str:
    """Format a numeric stat value for CSV output.

    Args:
        value: Numeric value.

    Returns:
        Compact decimal string.
    """
    return f"{value:.6f}".rstrip("0").rstrip(".")


def normalize_key(key: str) -> str:
    """Normalize a stat key to a stable identifier.

    Args:
        key: Raw key, which may contain spaces or mixed case.

    Returns:
        Lowercase snake-case-like identifier.
    """
    return key.strip().lower().replace(" ", "_")
