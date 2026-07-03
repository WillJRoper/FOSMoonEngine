"""Generate run_summary.yaml files from per-run CSV data.

Each run directory under ``public/assets/<family>/`` contains:

* ``final_snapshot_summary.csv`` — Metric / Value columns
* ``live_data_table.csv`` — time-series telemetry

This script reads those CSVs and writes a ``run_summary.yaml`` sidecar that the
frontend consumes for summary overlays and the live HUD.

Usage::

    python scripts/generate_run_summaries.py
"""

from __future__ import annotations

import csv
import hashlib
import re
import subprocess
from pathlib import Path

import yaml

from planetary_assets import find_reference_planetary_video

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = REPO_ROOT / "public" / "assets"

SIMULATION_DIRECTORIES = ("planetary", "galaxy", "cosmos")
SKIP_NAMES = frozenset({".DS_Store", "__pycache__", ".ipynb_checkpoints"})


def discover_runs(
    assets_root: Path | None = None,
    themes: tuple[str, ...] = SIMULATION_DIRECTORIES,
) -> dict[str, list[Path]]:
    """Return theme name -> sorted list of run directory Paths.

    Only directories that contain at least one file (recursively, excluding
    junk and hidden files) are considered runs.

    Args:
        assets_root: Root of the asset tree (defaults to ``public/assets``).
        themes: Simulation family directory names to scan.

    Returns:
        Mapping of theme name to a sorted list of run directory paths.
    """
    if assets_root is None:
        assets_root = ASSET_ROOT

    result: dict[str, list[Path]] = {}

    for theme in themes:
        theme_dir = assets_root / theme
        if not theme_dir.is_dir():
            continue
        runs: list[Path] = []
        for entry in sorted(theme_dir.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name in SKIP_NAMES or entry.name.startswith("."):
                continue
            if any(p.is_file() for p in entry.rglob("*")):
                runs.append(entry)
        if runs:
            result[theme] = runs

    return result


def load_summary_metrics(path: Path) -> dict[str, dict[str, str]]:
    """Read ``final_snapshot_summary.csv`` and return {key: {label, value}}.

    The CSV is expected to have ``Metric`` and ``Value`` columns. Rows with an
    empty Metric are skipped. Keys are normalised to lowercase snake_case.

    Args:
        path: Path to the CSV file.

    Returns:
        Dictionary keyed by normalised metric id, each value a dict with
        ``label`` and ``value`` keys.
    """
    if not path.exists():
        return {}

    summary_metrics: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            label = (row.get("Metric") or "").strip()
            value = (row.get("Value") or "").strip()
            if not label:
                continue
            summary_metrics[_normalize_key(label)] = {
                "label": label,
                "value": value,
            }
    return summary_metrics


def read_last_live_data_row(path: Path) -> dict[str, str]:
    """Return the final row of ``live_data_table.csv``.

    Args:
        path: Path to the CSV file.

    Returns:
        The last row as a dict of column-name -> value, or an empty dict if
        the file is missing or empty.
    """
    if not path.exists():
        return {}

    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        last_row: dict[str, str] | None = None
        for row in reader:
            last_row = dict(row)
    return last_row or {}


def build_resource_metrics(
    run_dir: Path,
    reference_video: Path,
    live_data_path: Path,
) -> dict[str, float | int]:
    """Derive resource metrics for a single run.

    Combines deterministic fake values (seeded from the run directory path)
    with the real particle-update count taken from the last row of the live
    data CSV.

    Args:
        run_dir: The run's directory (used as a seed for fake values).
        reference_video: Path to one of the run's video files (for duration).
        live_data_path: Path to ``live_data_table.csv``.

    Returns:
        Dict with keys ``wallclockSeconds``, ``computeUsed``, ``memoryUsed``,
        ``carbonBurnt``, and ``particlesUpdated``.
    """
    seed = int(hashlib.sha256(str(run_dir).encode("utf-8")).hexdigest()[:12], 16)
    duration_seconds = _probe_duration_seconds(reference_video)
    last_live_row = read_last_live_data_row(live_data_path)
    particles_updated = int(float(last_live_row.get("g_updates_total", "0") or 0))

    return {
        "wallclockSeconds": round(
            18 * 3600 + (seed % 11) * 5400 + duration_seconds * 120
        ),
        "computeUsed": round(18.0 + (seed % 37) * 1.35, 1),
        "memoryUsed": round(24.0 + (seed % 29) * 2.5, 1),
        "carbonBurnt": round(0.8 + (seed % 41) * 0.27, 2),
        "particlesUpdated": particles_updated,
    }


def write_run_summary_yaml(
    path: Path,
    resource_metrics: dict[str, float | int],
    summary_metrics: dict[str, dict[str, str]],
) -> None:
    """Write a ``run_summary.yaml`` sidecar file.

    Args:
        path: Destination path for the YAML file.
        resource_metrics: Dict of resource metric values.
        summary_metrics: Dict of per-metric label/value pairs (keyed by
            normalised id).
    """
    payload = {
        **resource_metrics,
        "summaryMetrics": summary_metrics,
    }
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")


def _probe_duration_seconds(video_path: Path) -> float:
    """Return the duration of a video file in seconds using ffprobe.

    Args:
        video_path: Path to the video file.

    Returns:
        Duration in seconds (>= 0.0).
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


def _normalize_key(label: str) -> str:
    """Convert a label string to a lowercase snake_case key.

    Args:
        label: A human-readable label (e.g. "Total Energy").

    Returns:
        Normalised key (e.g. "total_energy").
    """
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return re.sub(r"_+", "_", normalized)


def main() -> None:
    """Entry point: iterate over all runs and write run_summary.yaml files."""
    runs = discover_runs()

    for theme, run_dirs in runs.items():
        for run_dir in run_dirs:
            if theme == "planetary":
                reference_video = find_reference_planetary_video(run_dir)
                videos = [reference_video] if reference_video is not None else []
            else:
                animations_dir = run_dir / "animations"
                videos = (
                    sorted(animations_dir.glob("*.mp4")) if animations_dir.exists() else []
                )

            if not videos:
                print(f"  [skip] {run_dir.relative_to(ASSET_ROOT)} — no videos")
                continue

            final_summary_csv = run_dir / "final_snapshot_summary.csv"
            live_data_path = run_dir / "live_data_table.csv"
            run_summary_yaml = run_dir / "run_summary.yaml"

            summary_metrics = load_summary_metrics(final_summary_csv)
            resource_metrics = build_resource_metrics(
                run_dir, videos[0], live_data_path
            )
            write_run_summary_yaml(run_summary_yaml, resource_metrics, summary_metrics)
            print(f"  wrote {run_summary_yaml.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
