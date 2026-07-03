#!/usr/bin/env python3
"""Generate planetary ``live_data_table.csv`` files from local SWIFT timesteps.

Each planetary asset run directory is expected to contain a local
``timesteps.txt`` alongside ``parameters.yaml`` and ``run_summary.yaml``. This
script reads those local timestep files and writes ``live_data_table.csv``.

The generated CSV contains:

* ``t``: video playback time in seconds
* ``time_seconds``: simulation time in seconds
* ``g_updates_total``: cumulative gravitational particle updates
* ``particlesUpdated``: same cumulative total for convenience
"""

from __future__ import annotations

import argparse
import csv
import subprocess
from pathlib import Path

from planetary_assets import (
    find_reference_planetary_video,
    list_planetary_run_dirs_with_videos,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSETS_DIR = REPO_ROOT / "public" / "assets" / "planetary"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=DEFAULT_ASSETS_DIR,
        help="Directory containing per-run planetary asset subdirectories.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be written without modifying any files.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    assets_dir = args.assets_dir.expanduser().resolve()

    if not assets_dir.is_dir():
        raise SystemExit(f"ERROR: assets directory does not exist: {assets_dir}")

    run_dirs = list_planetary_run_dirs_with_videos(assets_dir)
    if not run_dirs:
        raise SystemExit(f"ERROR: no planetary asset runs with videos found in: {assets_dir}")

    wrote = 0
    skipped = 0

    for run_dir in run_dirs:
        timesteps_path = run_dir / "timesteps.txt"
        if not timesteps_path.is_file():
            print(f"  [skip] {display_path(run_dir)} - missing timesteps.txt")
            skipped += 1
            continue

        video_path = find_reference_planetary_video(run_dir)
        if video_path is None:
            print(f"  [skip] {display_path(run_dir)} - no animation video found")
            skipped += 1
            continue

        rows = build_rows(timesteps_path, probe_duration_seconds(video_path))
        if not rows:
            print(f"  [skip] {display_path(timesteps_path)} - no timestep rows parsed")
            skipped += 1
            continue

        output_path = run_dir / "live_data_table.csv"
        if args.dry_run:
            print(f"  [dry-run] would write {display_path(output_path)}")
        else:
            write_live_data_csv(output_path, rows)
            print(f"  wrote {display_path(output_path)}")
        wrote += 1

    print(f"wrote={wrote} skipped={skipped}")


def build_rows(timesteps_path: Path, video_duration_seconds: float) -> list[dict[str, str]]:
    entries = parse_timesteps(timesteps_path)
    if not entries:
        return []

    start_time = entries[0]["time_seconds"]
    end_time = entries[-1]["time_seconds"]
    time_span = max(end_time - start_time, 0.0)

    rows: list[dict[str, str]] = []
    cumulative_updates = 0

    for entry in entries:
        cumulative_updates += entry["g_updates"]
        relative_time = entry["time_seconds"] - start_time
        playback_time = scale_to_video_time(
            relative_time,
            time_span,
            video_duration_seconds,
        )
        rows.append(
            {
                "t": format_decimal(playback_time, 3),
                "time_seconds": format_decimal(entry["time_seconds"], 6),
                "g_updates_total": str(cumulative_updates),
                "particlesUpdated": str(cumulative_updates),
            }
        )

    return rows


def parse_timesteps(path: Path) -> list[dict[str, float | int]]:
    entries: list[dict[str, float | int]] = []

    with path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            fields = line.split()
            if len(fields) < 8:
                continue

            try:
                entries.append(
                    {
                        "time_seconds": float(fields[1]),
                        "g_updates": int(fields[7]),
                    }
                )
            except ValueError:
                continue

    return entries


def scale_to_video_time(
    relative_time_seconds: float,
    time_span_seconds: float,
    video_duration_seconds: float,
) -> float:
    if time_span_seconds <= 0 or video_duration_seconds <= 0:
        return 0.0
    return (relative_time_seconds / time_span_seconds) * video_duration_seconds


def write_live_data_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["t", "time_seconds", "g_updates_total", "particlesUpdated"],
        )
        writer.writeheader()
        writer.writerows(rows)


def probe_duration_seconds(video_path: Path) -> float:
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


def format_decimal(value: float, places: int) -> str:
    return f"{value:.{places}f}"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    main()
