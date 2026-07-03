#!/usr/bin/env python3
"""Create a randomly sampled video mosaic with ``ffmpeg``.

The script discovers all MP4 files nested under a directory at any depth,
randomly selects (with repetition) enough to fill an ``rows x cols`` grid, loops
each input indefinitely, scales and crops each tile to fit, and renders a
single 1080p mosaic video. With repetition, the grid can be filled even when
fewer unique videos exist than tiles.

Corrupt or unreadable MP4 files are silently skipped and reported at the end.
``.tmp.mp4`` files (incomplete transfers) are excluded from the pool.
"""

import argparse
import random
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed CLI namespace.
    """
    parser = argparse.ArgumentParser(
        description="Create a randomly sampled 1080p video mosaic."
    )
    parser.add_argument(
        "directory",
        type=Path,
        help="Directory containing input MP4 files.",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("mosaic.mp4"),
        help="Output filename.",
    )
    parser.add_argument(
        "--rows",
        type=int,
        default=4,
        help="Number of mosaic rows.",
    )
    parser.add_argument(
        "--cols",
        type=int,
        default=4,
        help="Number of mosaic columns.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=30.0,
        help="Output duration in seconds.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Output frame rate.",
    )
    parser.add_argument(
        "--border",
        type=int,
        default=4,
        help="Border thickness around each tile in pixels.",
    )
    parser.add_argument(
        "--border-color",
        default="white",
        help="Border color for each tile.",
    )
    return parser.parse_args()


def validate_video(path: Path) -> bool:
    """Return True if *path* is a readable MP4 with a video stream."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_type",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0 and "video" in result.stdout
    except (subprocess.TimeoutExpired, OSError):
        return False


def main() -> None:
    """Create the requested mosaic video."""
    args = parse_args()

    if args.rows <= 0 or args.cols <= 0:
        raise ValueError("Rows and columns must both be positive.")
    if args.border < 0:
        raise ValueError("Border must be non-negative.")

    all_files = sorted(args.directory.rglob("*.mp4"))
    tile_count = args.rows * args.cols

    if not all_files:
        raise RuntimeError(f"No MP4 files found under {args.directory}.")

    raw_files = [
        f for f in all_files
        if not f.name.endswith(".tmp.mp4") and not f.is_symlink()
    ]

    valid_files: list[Path] = []
    skipped_files: list[tuple[Path, str]] = []

    for path in raw_files:
        if validate_video(path):
            valid_files.append(path)
        else:
            skipped_files.append((path, "ffprobe validation failed"))

    for path in all_files:
        if path not in raw_files:
            skipped_files.append((path, "excluded (.tmp.mp4 or symlink)"))

    if not valid_files:
        raise RuntimeError(
            f"No valid MP4 files found under {args.directory} "
            f"({len(skipped_files)} skipped)."
        )

    selected = random.choices(valid_files, k=tile_count)

    output_width = 1920
    output_height = 1080

    tile_width = output_width // args.cols
    tile_height = output_height // args.rows
    inner_width = tile_width - 2 * args.border
    inner_height = tile_height - 2 * args.border

    if inner_width <= 0 or inner_height <= 0:
        raise ValueError(
            "Border is too large for the computed tile size; inner width and height must remain positive."
        )

    command = ["ffmpeg", "-y"]

    for filename in selected:
        command.extend(
            [
                "-stream_loop",
                "-1",
                "-i",
                str(filename),
            ]
        )

    filter_parts = []

    for index in range(tile_count):
        filter_parts.append(
            f"[{index}:v]"
            f"scale={inner_width}:{inner_height}:"
            f"force_original_aspect_ratio=increase,"
            f"crop={inner_width}:{inner_height},"
            f"pad={tile_width}:{tile_height}:{args.border}:{args.border}:{args.border_color},"
            f"fps={args.fps},"
            f"setpts=PTS-STARTPTS"
            f"[v{index}]"
        )

    inputs = "".join(f"[v{index}]" for index in range(tile_count))

    layout = "|".join(
        f"{column * tile_width}_{row * tile_height}"
        for row in range(args.rows)
        for column in range(args.cols)
    )

    filter_parts.append(
        f"{inputs}xstack=inputs={tile_count}:layout={layout}:fill=black[out]"
    )

    command.extend(
        [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[out]",
            "-t",
            str(args.duration),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(args.output),
        ]
    )

    print(f"Discovered {len(all_files)} MP4 file(s), {len(valid_files)} valid.")
    if skipped_files:
        print("Skipped (corrupt, temp, or unreadable):")
        for path, reason in sorted(skipped_files):
            print(f"  {path}  [{reason}]")
    print()
    print("Selected videos:")
    for filename in selected:
        print(f"  {filename}")

    subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
