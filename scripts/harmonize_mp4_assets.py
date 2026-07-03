#!/usr/bin/env python3
"""Harmonize MP4 assets for smoother browser playback and scrubbing.

Recursively scans an asset tree for ``.mp4`` files, skips generated build
directories such as ``dist/``, and converts non-compliant files to a common
H.264 delivery profile.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_DIRECTORY_NAMES = frozenset({"dist", ".git", "__pycache__"})
MAX_WIDTH = 1920
MAX_HEIGHT = 1080
GOP_DURATION_SECONDS = 0.6
STOP_EVENT = threading.Event()
TEMP_PATHS: set[Path] = set()
TEMP_PATHS_LOCK = threading.Lock()


@dataclass(frozen=True)
class CliOptions:
    """Parsed command-line options for the harmonizer."""

    assets_dir: Path
    fps: int
    gop_duration_seconds: float
    crf: int
    preset: str
    jobs: int
    dry_run: bool
    check: bool
    force: bool
    runtime: float | None


@dataclass(frozen=True)
class VideoProbe:
    """Subset of video metadata required for compliance checks."""

    path: Path
    duration_seconds: float
    codec_name: str
    profile: str
    level: int
    width: int
    height: int
    pixel_format: str
    avg_frame_rate: str
    r_frame_rate: str
    audio_stream_count: int
    has_faststart: bool
    max_keyframe_gap_seconds: float


@dataclass(frozen=True)
class ScanResult:
    """Filesystem scan results for MP4 discovery."""

    files: list[Path]
    symlinks: list[Path]


@dataclass(frozen=True)
class ComplianceResult:
    """Compliance check result for one probed MP4 file."""

    compliant: bool
    issues: list[str]
    probe: VideoProbe


@dataclass(frozen=True)
class FileOutcome:
    """Conversion outcome for one processed MP4 file."""

    path: Path
    status: str
    message: str
    original_size: int
    output_size: int
    changed: bool
    failed: bool


@dataclass
class Summary:
    """Aggregate counters and failure details for a harmonizer run."""

    total_files: int = 0
    symlinks_skipped: int = 0
    compliant_skipped: int = 0
    check_non_compliant: int = 0
    dry_run_pending: int = 0
    converted: int = 0
    failed: int = 0
    bytes_before: int = 0
    bytes_after: int = 0
    failures: list[str] = field(default_factory=list)
    broken_files: list[str] = field(default_factory=list)
    removed_run_dirs: list[str] = field(default_factory=list)


def parse_args() -> CliOptions:
    """Parse CLI arguments for the harmonizer."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "assets_dir",
        type=Path,
        help="Root assets directory to scan recursively for MP4 files.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Output constant frame rate in frames per second (default: 30).",
    )
    parser.add_argument(
        "--gop-duration",
        type=float,
        default=GOP_DURATION_SECONDS,
        help=(
            "Target closed-GOP duration in seconds for scrub responsiveness "
            f"(default: {GOP_DURATION_SECONDS})."
        ),
    )
    parser.add_argument(
        "--crf",
        type=int,
        default=23,
        help="CRF quality value passed to libx264 (default: 23).",
    )
    parser.add_argument(
        "--preset",
        default="slow",
        help="libx264 preset to use (default: slow).",
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
        help="Report what would be converted without modifying files.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Audit compliance only; do not convert files.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-encode files even when they already satisfy the target profile.",
    )
    parser.add_argument(
        "--runtime",
        type=float,
        default=None,
        help=(
            "Target runtime in seconds. Stretches or squashes the video to "
            "match this duration by adjusting playback speed (setpts filter). "
            "Source duration is preserved when omitted."
        ),
    )
    args = parser.parse_args()

    assets_dir = args.assets_dir.expanduser().resolve()
    if not assets_dir.is_dir():
        raise SystemExit(f"Assets directory does not exist: {assets_dir}")
    if args.fps <= 0:
        raise SystemExit("--fps must be a positive integer")
    if args.gop_duration <= 0:
        raise SystemExit("--gop-duration must be a positive number")
    if args.jobs <= 0:
        raise SystemExit("--jobs must be a positive integer")
    if args.crf < 0:
        raise SystemExit("--crf must be non-negative")
    if args.runtime is not None and args.runtime <= 0:
        raise SystemExit("--runtime must be a positive number")

    return CliOptions(
        assets_dir=assets_dir,
        fps=args.fps,
        gop_duration_seconds=args.gop_duration,
        crf=args.crf,
        preset=args.preset,
        jobs=args.jobs,
        dry_run=args.dry_run,
        check=args.check,
        force=args.force,
        runtime=args.runtime,
    )


def ensure_dependencies() -> None:
    """Exit if required media tools are unavailable."""
    missing = [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]
    if missing:
        joined = ", ".join(missing)
        raise SystemExit(f"Required tool(s) not found in PATH: {joined}")


def calculate_gop_frames(fps: int, gop_duration_seconds: float) -> int:
    """Return the GOP size, in frames, for a fixed closed GOP duration."""
    if fps <= 0:
        raise ValueError("fps must be positive")
    if gop_duration_seconds <= 0:
        raise ValueError("gop_duration_seconds must be positive")
    return max(1, round(fps * gop_duration_seconds))


def duration_tolerance_seconds(fps: int) -> float:
    """Allow output duration to drift by up to one second."""
    _ = fps
    return 1.0


def keyframe_gap_tolerance_seconds(fps: int) -> float:
    """Allow keyframe spacing to drift by at most one output frame."""
    return 1.0 / fps


def is_excluded_directory(path: Path) -> bool:
    """Return True when *path* should not be traversed or processed."""
    return any(part in EXCLUDED_DIRECTORY_NAMES for part in path.parts)


def discover_mp4_files(assets_dir: Path) -> ScanResult:
    """Recursively discover eligible MP4 files below *assets_dir*."""
    files: list[Path] = []
    symlinks: list[Path] = []

    for root, dir_names, file_names in os.walk(
        assets_dir, topdown=True, followlinks=False
    ):
        root_path = Path(root)
        dir_names[:] = [
            name
            for name in sorted(dir_names)
            if _keep_walk_directory(root_path / name, symlinks)
        ]

        if is_excluded_directory(root_path.relative_to(assets_dir)):
            dir_names[:] = []
            continue

        for file_name in sorted(file_names):
            file_path = root_path / file_name
            if file_path.is_symlink():
                symlinks.append(file_path)
                continue
            if file_path.suffix.lower() != ".mp4":
                continue
            if is_excluded_directory(file_path.relative_to(assets_dir).parent):
                continue
            files.append(file_path)

    return ScanResult(files=files, symlinks=sorted(symlinks))


def _keep_walk_directory(path: Path, symlinks: list[Path]) -> bool:
    """Return True when a discovered directory should be traversed."""
    if path.is_symlink():
        symlinks.append(path)
        return False
    if is_excluded_directory(Path(path.name)):
        return False
    return True


def infer_run_directory(assets_dir: Path, mp4_path: Path) -> Path:
    """Return the run directory that owns *mp4_path*.

    Current assets are typically laid out as ``<family>/<run>/animations/*.mp4``.
    When an ``animations`` segment is present, the run directory is its parent.
    Otherwise we conservatively treat the file's direct parent as the run.
    """
    relative_parts = mp4_path.relative_to(assets_dir).parts
    if "animations" in relative_parts:
        animations_index = relative_parts.index("animations")
        if animations_index > 0:
            return assets_dir.joinpath(*relative_parts[:animations_index])
    return mp4_path.parent


def probe_video(path: Path) -> VideoProbe:
    """Collect the metadata required for compliance checks."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        raise ValueError(f"No video stream found in {path}")

    duration_raw = payload.get("format", {}).get("duration")
    duration_seconds = max(float(duration_raw or 0.0), 0.0)
    audio_stream_count = sum(
        1 for stream in streams if stream.get("codec_type") == "audio"
    )

    return VideoProbe(
        path=path,
        duration_seconds=duration_seconds,
        codec_name=str(video_stream.get("codec_name") or ""),
        profile=str(video_stream.get("profile") or ""),
        level=int(video_stream.get("level") or 0),
        width=int(video_stream.get("width") or 0),
        height=int(video_stream.get("height") or 0),
        pixel_format=str(video_stream.get("pix_fmt") or ""),
        avg_frame_rate=str(video_stream.get("avg_frame_rate") or "0/0"),
        r_frame_rate=str(video_stream.get("r_frame_rate") or "0/0"),
        audio_stream_count=audio_stream_count,
        has_faststart=has_faststart_layout(path),
        max_keyframe_gap_seconds=get_max_keyframe_gap_seconds(path),
    )


def parse_frame_rate(value: str) -> float:
    """Convert an ffprobe frame-rate string such as ``30000/1001`` to float."""
    numerator, _, denominator = value.partition("/")
    if not numerator:
        return 0.0
    if not denominator:
        return float(numerator)
    denominator_value = float(denominator)
    if denominator_value == 0:
        return 0.0
    return float(numerator) / denominator_value


def has_faststart_layout(path: Path) -> bool:
    """Return True when the MP4 moov atom appears before mdat."""
    chunk_size = 1024 * 1024
    previous_tail = b""
    seen_moov = False
    seen_mdat = False

    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            haystack = previous_tail + chunk
            moov_index = haystack.find(b"moov")
            mdat_index = haystack.find(b"mdat")
            if moov_index != -1:
                seen_moov = True
            if mdat_index != -1:
                seen_mdat = True
            if seen_moov and seen_mdat:
                return moov_index != -1 and (
                    mdat_index == -1 or moov_index < mdat_index
                )
            if seen_mdat and not seen_moov:
                return False
            previous_tail = haystack[-3:]

    return seen_moov and not seen_mdat


def get_max_keyframe_gap_seconds(path: Path) -> float:
    """Return the maximum gap between keyframes in seconds."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-skip_frame",
        "nokey",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    timestamps = [
        float(line.strip()) for line in result.stdout.splitlines() if line.strip()
    ]
    if len(timestamps) < 2:
        return 0.0

    max_gap = 0.0
    previous = timestamps[0]
    for current in timestamps[1:]:
        max_gap = max(max_gap, current - previous)
        previous = current
    return max_gap


def check_compliance(
    path: Path, fps: int, gop_duration_seconds: float
) -> ComplianceResult:
    """Validate one MP4 against the requested target profile."""
    probe = probe_video(path)
    issues = get_probe_issues(
        probe,
        fps=fps,
        gop_duration_seconds=gop_duration_seconds,
    )
    return ComplianceResult(compliant=not issues, issues=issues, probe=probe)


def get_probe_issues(
    probe: VideoProbe, fps: int, gop_duration_seconds: float
) -> list[str]:
    """Return a list of compliance issues for *probe*."""
    issues: list[str] = []
    expected_fps = float(fps)
    measured_fps = parse_frame_rate(probe.avg_frame_rate)
    max_keyframe_gap = gop_duration_seconds + keyframe_gap_tolerance_seconds(fps)

    if probe.codec_name != "h264":
        issues.append(f"codec={probe.codec_name}")
    if probe.profile != "High":
        issues.append(f"profile={probe.profile}")
    if probe.level != 41:
        issues.append(f"level={probe.level}")
    if probe.pixel_format != "yuv420p":
        issues.append(f"pix_fmt={probe.pixel_format}")
    if abs(measured_fps - expected_fps) > 1e-6:
        issues.append(f"fps={probe.avg_frame_rate}")
    if probe.width > MAX_WIDTH or probe.height > MAX_HEIGHT:
        issues.append(f"dimensions={probe.width}x{probe.height}")
    if probe.max_keyframe_gap_seconds > max_keyframe_gap:
        issues.append(f"max_keyframe_gap={probe.max_keyframe_gap_seconds:.3f}s")
    if probe.audio_stream_count != 0:
        issues.append(f"audio_streams={probe.audio_stream_count}")
    if not probe.has_faststart:
        issues.append("faststart=false")

    return issues


def build_ffmpeg_command(
    input_path: Path,
    output_path: Path,
    *,
    fps: int,
    gop_duration_seconds: float,
    crf: int,
    preset: str,
    runtime: float | None = None,
    source_duration_seconds: float = 0.0,
) -> list[str]:
    """Build the ffmpeg argv list for one output conversion."""
    gop_frames = calculate_gop_frames(fps, gop_duration_seconds)
    scale_filter = (
        f"scale=w='min(iw,{MAX_WIDTH})':h='min(ih,{MAX_HEIGHT})':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )
    if runtime is not None and source_duration_seconds > 0:
        setpts_factor = runtime / source_duration_seconds
        scale_filter += f",setpts={setpts_factor}*PTS"
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vf",
        scale_filter,
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level:v",
        "4.1",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        preset,
        "-crf",
        str(crf),
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
        str(output_path),
    ]


def validate_output(
    source_probe: VideoProbe,
    output_path: Path,
    *,
    fps: int,
    gop_duration_seconds: float,
    runtime: float | None = None,
) -> ComplianceResult:
    """Validate the converted output, including duration preservation."""
    result = check_compliance(
        output_path,
        fps=fps,
        gop_duration_seconds=gop_duration_seconds,
    )
    expected_duration = (
        runtime if runtime is not None else source_probe.duration_seconds
    )
    duration_delta = abs(result.probe.duration_seconds - expected_duration)
    if duration_delta > duration_tolerance_seconds(fps):
        issues = list(result.issues)
        issues.append(
            f"duration_delta={duration_delta:.6f}s exceeds {duration_tolerance_seconds(fps):.6f}s"
        )
        return ComplianceResult(compliant=False, issues=issues, probe=result.probe)
    return result


def format_size(num_bytes: int) -> str:
    """Return a human-readable size string."""
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024.0:
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} PB"


def format_percent_change(before: int, after: int) -> str:
    """Return signed percentage size change between *before* and *after*."""
    if before <= 0:
        return "n/a"
    percent = ((after - before) / before) * 100.0
    return f"{percent:+.1f}%"


def register_temp_path(path: Path) -> None:
    """Track a temp output for later cleanup."""
    with TEMP_PATHS_LOCK:
        TEMP_PATHS.add(path)


def unregister_temp_path(path: Path) -> None:
    """Remove a temp output from the cleanup set."""
    with TEMP_PATHS_LOCK:
        TEMP_PATHS.discard(path)


def cleanup_temp_paths() -> None:
    """Remove any temporary files that are still registered."""
    with TEMP_PATHS_LOCK:
        temp_paths = list(TEMP_PATHS)
        TEMP_PATHS.clear()
    for temp_path in temp_paths:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def run_ffmpeg(argv: list[str]) -> None:
    """Run ffmpeg and allow cooperative interruption cleanup."""
    process = subprocess.Popen(argv)
    try:
        while True:
            if STOP_EVENT.is_set():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise RuntimeError("Interrupted")

            return_code = process.poll()
            if return_code is not None:
                if return_code != 0:
                    raise subprocess.CalledProcessError(return_code, argv)
                return

            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def convert_file(path: Path, options: CliOptions) -> FileOutcome:
    """Convert one MP4 file and replace it atomically after validation."""
    original_size = path.stat().st_size
    source_probe = probe_video(path)

    temp_handle = tempfile.NamedTemporaryFile(
        prefix=f"{path.stem}.",
        suffix=".tmp.mp4",
        dir=path.parent,
        delete=False,
    )
    temp_handle.close()
    temp_path = Path(temp_handle.name)
    register_temp_path(temp_path)

    try:
        command = build_ffmpeg_command(
            path,
            temp_path,
            fps=options.fps,
            gop_duration_seconds=options.gop_duration_seconds,
            crf=options.crf,
            preset=options.preset,
            runtime=options.runtime,
            source_duration_seconds=source_probe.duration_seconds,
        )
        run_ffmpeg(command)

        validation = validate_output(
            source_probe,
            temp_path,
            fps=options.fps,
            gop_duration_seconds=options.gop_duration_seconds,
            runtime=options.runtime,
        )
        if not validation.compliant:
            raise RuntimeError("; ".join(validation.issues))

        output_size = temp_path.stat().st_size
        os.replace(temp_path, path)
        unregister_temp_path(temp_path)
        return FileOutcome(
            path=path,
            status="converted",
            message="converted",
            original_size=original_size,
            output_size=output_size,
            changed=True,
            failed=False,
        )
    except Exception as exc:
        try:
            temp_path.unlink(missing_ok=True)
        finally:
            unregister_temp_path(temp_path)
        return FileOutcome(
            path=path,
            status="failed",
            message=str(exc),
            original_size=original_size,
            output_size=0,
            changed=False,
            failed=True,
        )


def remove_run_directories(
    assets_dir: Path,
    run_dirs: set[Path],
    *,
    dry_run: bool,
) -> list[str]:
    """Remove run directories that should be discarded."""
    removed: list[str] = []

    for run_dir in sorted(run_dirs):
        display = str(run_dir)
        try:
            display = str(run_dir.relative_to(assets_dir))
        except ValueError:
            pass

        if dry_run:
            removed.append(f"[dry-run] {display}")
            continue

        shutil.rmtree(run_dir)
        removed.append(display)

    return removed


def install_signal_handlers() -> None:
    """Set a cooperative stop flag when interrupted."""
    previous_handler = signal.getsignal(signal.SIGINT)

    def _handle_interrupt(signum: int, frame: Any) -> None:
        STOP_EVENT.set()
        if callable(previous_handler):
            previous_handler(signum, frame)
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _handle_interrupt)


def main() -> None:
    """CLI entrypoint."""
    options = parse_args()
    ensure_dependencies()
    install_signal_handlers()

    scan = discover_mp4_files(options.assets_dir)
    summary = Summary(total_files=len(scan.files), symlinks_skipped=len(scan.symlinks))

    print(f"Scanning assets: {options.assets_dir}")
    print(f"Found {len(scan.files)} MP4 file(s)")
    for symlink in scan.symlinks:
        print(f"[skip symlink] {symlink}")

    work_items: list[tuple[int, Path]] = []
    run_dirs_by_file = {
        path: infer_run_directory(options.assets_dir, path) for path in scan.files
    }
    all_run_dirs: set[Path] = set(run_dirs_by_file.values())
    working_run_dirs: set[Path] = set()

    try:
        for index, path in enumerate(scan.files, start=1):
            size = path.stat().st_size
            summary.bytes_before += size

            prefix = f"[{index}/{len(scan.files)}]"
            try:
                compliance = check_compliance(
                    path,
                    fps=options.fps,
                    gop_duration_seconds=options.gop_duration_seconds,
                )
            except Exception as exc:
                summary.failed += 1
                summary.failures.append(f"{path}: {exc}")
                summary.broken_files.append(f"{path}: {exc}")
                print(f"{prefix} failed {path}: {exc}")
                continue

            working_run_dirs.add(run_dirs_by_file[path])

            if compliance.compliant and not options.force:
                summary.compliant_skipped += 1
                print(f"{prefix} compliant {path} ({format_size(size)})")
                continue

            if options.check:
                if compliance.compliant:
                    summary.compliant_skipped += 1
                    print(f"{prefix} compliant {path} ({format_size(size)})")
                else:
                    summary.check_non_compliant += 1
                    summary.failed += 1
                    summary.failures.append(f"{path}: {'; '.join(compliance.issues)}")
                    print(
                        f"{prefix} non-compliant {path} ({format_size(size)}): "
                        f"{'; '.join(compliance.issues)}"
                    )
                continue

            if options.dry_run:
                summary.dry_run_pending += 1
                action = (
                    "would re-encode"
                    if options.force and compliance.compliant
                    else "would convert"
                )
                detail = (
                    "already compliant but forced"
                    if compliance.compliant
                    else "; ".join(compliance.issues)
                )
                print(f"{prefix} {action} {path} ({format_size(size)}): {detail}")
                continue

            work_items.append((index, path))

        if work_items:
            with ThreadPoolExecutor(max_workers=options.jobs) as executor:
                futures = {
                    executor.submit(convert_file, path, options): (index, path)
                    for index, path in work_items
                }
                for future in as_completed(futures):
                    index, path = futures[future]
                    prefix = f"[{index}/{len(scan.files)}]"
                    outcome = future.result()
                    if outcome.failed:
                        summary.failed += 1
                        summary.failures.append(f"{path}: {outcome.message}")
                        summary.broken_files.append(f"{path}: {outcome.message}")
                        print(f"{prefix} failed {path}: {outcome.message}")
                        continue

                    summary.converted += 1
                    summary.bytes_after += outcome.output_size
                    print(
                        f"{prefix} converted {path}: "
                        f"{format_size(outcome.original_size)} -> {format_size(outcome.output_size)} "
                        f"({format_percent_change(outcome.original_size, outcome.output_size)})"
                    )

        run_dirs_without_working_mp4s = all_run_dirs - working_run_dirs
        if run_dirs_without_working_mp4s:
            summary.removed_run_dirs = remove_run_directories(
                options.assets_dir,
                run_dirs_without_working_mp4s,
                dry_run=options.dry_run or options.check,
            )
        summary.bytes_after = sum(
            path.stat().st_size for path in scan.files if path.exists()
        )

    except KeyboardInterrupt:
        STOP_EVENT.set()
        cleanup_temp_paths()
        raise SystemExit(130)
    finally:
        cleanup_temp_paths()

    print()
    print("Summary")
    print(f"  MP4 files discovered: {summary.total_files}")
    print(f"  Symlinks skipped:     {summary.symlinks_skipped}")
    print(f"  Compliant skipped:    {summary.compliant_skipped}")
    print(f"  Dry-run pending:      {summary.dry_run_pending}")
    print(f"  Converted:            {summary.converted}")
    print(f"  Check non-compliant:  {summary.check_non_compliant}")
    print(f"  Failures:             {summary.failed}")
    print(f"  Broken MP4s:          {len(summary.broken_files)}")
    print(f"  Run dirs removed:     {len(summary.removed_run_dirs)}")
    print(f"  Total size before:    {format_size(summary.bytes_before)}")
    print(f"  Total size after:     {format_size(summary.bytes_after)}")
    print(
        f"  Net size change:      {format_percent_change(summary.bytes_before, summary.bytes_after)}"
    )
    if summary.failed:
        print("  Failure details:")
        for failure in summary.failures:
            print(f"    - {failure}")
    if summary.broken_files:
        print("  Broken MP4 details:")
        for broken_file in summary.broken_files:
            print(f"    - {broken_file}")
    if summary.removed_run_dirs:
        print("  Removed run directories:")
        for run_dir in summary.removed_run_dirs:
            print(f"    - {run_dir}")

    if summary.failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
