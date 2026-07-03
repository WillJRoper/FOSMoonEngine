#!/usr/bin/env python3
"""Remove planetary runs whose videos fail ffprobe.

The script scans local planetary asset run directories that contain videos,
probes every video with ``ffprobe``, and treats a run as broken if any of its
videos fail to probe. Broken run directories are reported to
``broken_videos.txt`` and removed unless ``--dry-run`` is set.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

from planetary_assets import list_planetary_run_dirs_with_videos, list_planetary_videos

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSETS_DIR = REPO_ROOT / "public" / "assets" / "planetary"
DEFAULT_REPORT_NAME = "broken_videos.txt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=DEFAULT_ASSETS_DIR,
        help="Directory containing per-run planetary asset subdirectories.",
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        help="Output path for the broken-video report (default: <assets-dir>/broken_videos.txt).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report broken runs without deleting their directories.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    assets_dir = args.assets_dir.expanduser().resolve()
    report_path = resolve_report_path(args.report_path, assets_dir)

    if not assets_dir.is_dir():
        raise SystemExit(f"ERROR: assets directory does not exist: {assets_dir}")

    run_dirs = list_planetary_run_dirs_with_videos(assets_dir)
    if not run_dirs:
        raise SystemExit(f"ERROR: no planetary asset runs with videos found in: {assets_dir}")

    broken_runs: list[Path] = []

    for run_dir in run_dirs:
        broken_video = find_broken_video(run_dir)
        if broken_video is None:
            continue

        broken_runs.append(run_dir)
        if args.dry_run:
            print(
                f"  [dry-run] would remove {display_path(run_dir)} - broken video {broken_video.name}"
            )
        else:
            shutil.rmtree(run_dir)
            print(f"  removed {display_path(run_dir)} - broken video {broken_video.name}")

    write_report(report_path, broken_runs)
    print(f"report={display_path(report_path)} broken={len(broken_runs)}")


def resolve_report_path(report_path: Path | None, assets_dir: Path) -> Path:
    if report_path is None:
        return assets_dir / DEFAULT_REPORT_NAME
    return report_path.expanduser().resolve()


def find_broken_video(run_dir: Path) -> Path | None:
    for video_path in list_planetary_videos(run_dir):
        if not video_probes_cleanly(video_path):
            return video_path
    return None


def video_probes_cleanly(video_path: Path) -> bool:
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

    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False

    try:
        return float(result.stdout.strip()) > 0
    except ValueError:
        return False


def write_report(report_path: Path, broken_runs: list[Path]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    contents = "".join(f"{display_path(run_dir)}\n" for run_dir in broken_runs)
    report_path.write_text(contents, encoding="utf-8")


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    main()
