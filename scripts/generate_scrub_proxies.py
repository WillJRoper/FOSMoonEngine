#!/usr/bin/env python3
"""Generate low-resolution MP4 scrub proxies beside simulation videos.

Scans an asset tree for files laid out as ``<family>/<run>/animations/*.mp4`` and
writes scrub-friendly proxy videos to ``<family>/<run>/animations_scrub/*.mp4``.
These proxies are intended for timeline dragging, where immediate perceived
control matters more than full-resolution playback fidelity. The default encode
profile favors seek responsiveness over compression efficiency: 1080p max,
15 fps, and one keyframe per frame.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

EXCLUDED_DIRECTORY_NAMES = frozenset({"dist", ".git", "__pycache__"})
DEFAULT_MAX_WIDTH = 1920
DEFAULT_MAX_HEIGHT = 1080
DEFAULT_FPS = 15
DEFAULT_GOP_DURATION_SECONDS = 1 / DEFAULT_FPS


@dataclass(frozen=True)
class CliOptions:
    assets_dir: Path
    fps: int
    gop_duration_seconds: float
    crf: int
    preset: str
    max_width: int
    max_height: int
    jobs: int
    dry_run: bool
    force: bool


@dataclass(frozen=True)
class ProxyTask:
    source_path: Path
    output_path: Path


@dataclass(frozen=True)
class ProxyOutcome:
    task: ProxyTask
    status: str
    message: str


def parse_args() -> CliOptions:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "assets_dir",
        type=Path,
        help="Root assets directory to scan for animations/*.mp4 files.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=DEFAULT_FPS,
        help=f"Output proxy frame rate (default: {DEFAULT_FPS}).",
    )
    parser.add_argument(
        "--gop-duration",
        type=float,
        default=DEFAULT_GOP_DURATION_SECONDS,
        help=(
            "Closed-GOP duration in seconds for fast scrubbing "
            f"(default: {DEFAULT_GOP_DURATION_SECONDS})."
        ),
    )
    parser.add_argument(
        "--crf",
        type=int,
        default=20,
        help="libx264 CRF for proxy quality (default: 20).",
    )
    parser.add_argument(
        "--preset",
        default="medium",
        help="libx264 preset for proxy encoding (default: medium).",
    )
    parser.add_argument(
        "--max-width",
        type=int,
        default=DEFAULT_MAX_WIDTH,
        help=f"Maximum proxy width (default: {DEFAULT_MAX_WIDTH}).",
    )
    parser.add_argument(
        "--max-height",
        type=int,
        default=DEFAULT_MAX_HEIGHT,
        help=f"Maximum proxy height (default: {DEFAULT_MAX_HEIGHT}).",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=max(1, min(4, os.cpu_count() or 1)),
        help="Maximum concurrent FFmpeg jobs (default: min(4, CPU count)).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report planned outputs without writing files.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild proxies even when output files already exist.",
    )
    args = parser.parse_args()

    assets_dir = args.assets_dir.expanduser().resolve()
    if not assets_dir.is_dir():
        raise SystemExit(f"Assets directory does not exist: {assets_dir}")
    if args.fps <= 0:
        raise SystemExit("--fps must be a positive integer")
    if args.gop_duration <= 0:
        raise SystemExit("--gop-duration must be positive")
    if args.crf < 0:
        raise SystemExit("--crf must be non-negative")
    if args.max_width <= 0 or args.max_height <= 0:
        raise SystemExit("--max-width and --max-height must be positive")
    if args.jobs <= 0:
        raise SystemExit("--jobs must be a positive integer")

    return CliOptions(
        assets_dir=assets_dir,
        fps=args.fps,
        gop_duration_seconds=args.gop_duration,
        crf=args.crf,
        preset=args.preset,
        max_width=args.max_width,
        max_height=args.max_height,
        jobs=args.jobs,
        dry_run=args.dry_run,
        force=args.force,
    )


def ensure_dependencies() -> None:
    missing = [tool for tool in ("ffmpeg",) if shutil.which(tool) is None]
    if missing:
        raise SystemExit(f"Required tool(s) not found in PATH: {', '.join(missing)}")


def is_excluded_directory(path: Path) -> bool:
    return any(part in EXCLUDED_DIRECTORY_NAMES for part in path.parts)


def discover_proxy_tasks(assets_dir: Path) -> list[ProxyTask]:
    tasks: list[ProxyTask] = []

    for root, dir_names, file_names in os.walk(assets_dir, topdown=True, followlinks=False):
        root_path = Path(root)
        relative_root = root_path.relative_to(assets_dir)
        dir_names[:] = [
            name
            for name in sorted(dir_names)
            if not is_excluded_directory(relative_root / name)
        ]

        if root_path.name != "animations" or is_excluded_directory(relative_root):
            continue

        scrub_dir = root_path.parent / "animations_scrub"
        for file_name in sorted(file_names):
            if not file_name.lower().endswith(".mp4"):
                continue

            source_path = root_path / file_name
            output_path = scrub_dir / file_name
            tasks.append(ProxyTask(source_path=source_path, output_path=output_path))

    return tasks


def should_build(task: ProxyTask, *, force: bool) -> bool:
    if force or not task.output_path.exists():
        return True
    return task.output_path.stat().st_mtime < task.source_path.stat().st_mtime


def calculate_gop_frames(fps: int, gop_duration_seconds: float) -> int:
    return max(1, round(fps * gop_duration_seconds))


def build_ffmpeg_command(task: ProxyTask, options: CliOptions, temp_output: Path) -> list[str]:
    gop_frames = calculate_gop_frames(options.fps, options.gop_duration_seconds)
    scale_filter = (
        f"scale=w='min(iw,{options.max_width})':h='min(ih,{options.max_height})':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(task.source_path),
        "-vf",
        scale_filter,
        "-r",
        str(options.fps),
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level:v",
        "4.2",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        options.preset,
        "-crf",
        str(options.crf),
        "-g",
        str(gop_frames),
        "-keyint_min",
        str(gop_frames),
        "-sc_threshold",
        "0",
        "-bf",
        "2",
        "-x264-params",
        "open-gop=0",
        "-movflags",
        "+faststart",
        "-an",
        str(temp_output),
    ]


def build_proxy(task: ProxyTask, options: CliOptions) -> ProxyOutcome:
    display = f"{task.source_path} -> {task.output_path}"

    if not should_build(task, force=options.force):
        return ProxyOutcome(task=task, status="skip", message="up-to-date")

    if options.dry_run:
        return ProxyOutcome(task=task, status="dry-run", message=display)

    task.output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_handle = tempfile.NamedTemporaryFile(
        prefix=f"{task.output_path.stem}.",
        suffix=".tmp.mp4",
        dir=task.output_path.parent,
        delete=False,
    )
    temp_handle.close()
    temp_output = Path(temp_handle.name)

    try:
        subprocess.run(
            build_ffmpeg_command(task, options, temp_output),
            check=True,
            capture_output=True,
            text=True,
        )
        os.replace(temp_output, task.output_path)
        return ProxyOutcome(task=task, status="built", message=display)
    except subprocess.CalledProcessError as exc:
        temp_output.unlink(missing_ok=True)
        detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        return ProxyOutcome(task=task, status="failed", message=detail)
    except Exception as exc:
        temp_output.unlink(missing_ok=True)
        return ProxyOutcome(task=task, status="failed", message=str(exc))


def emit(message: str = "") -> None:
    print(message, flush=True)


def main() -> None:
    options = parse_args()
    ensure_dependencies()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True, write_through=True)

    tasks = discover_proxy_tasks(options.assets_dir)
    emit(f"Scanning assets: {options.assets_dir}")
    emit(f"Discovered {len(tasks)} source video(s) under animations/")

    if not tasks:
        return

    built = 0
    skipped = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=options.jobs) as executor:
        futures = {executor.submit(build_proxy, task, options): task for task in tasks}

        for index, future in enumerate(as_completed(futures), start=1):
            outcome = future.result()
            rel_source = outcome.task.source_path.relative_to(options.assets_dir)
            rel_output = outcome.task.output_path.relative_to(options.assets_dir)
            prefix = f"[{index}/{len(tasks)}]"

            if outcome.status == "built":
                built += 1
                emit(f"{prefix} built {rel_source} -> {rel_output}")
            elif outcome.status == "skip":
                skipped += 1
                emit(f"{prefix} skip {rel_output} ({outcome.message})")
            elif outcome.status == "dry-run":
                skipped += 1
                emit(f"{prefix} dry-run {rel_source} -> {rel_output}")
            else:
                failed += 1
                emit(f"{prefix} failed {rel_source}: {outcome.message}")

    emit()
    emit(
        f"Done. built={built} skipped={skipped} failed={failed} "
        f"jobs={options.jobs} fps={options.fps} max={options.max_width}x{options.max_height}"
    )

    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
