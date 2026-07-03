#!/usr/bin/env python3
"""Shared helpers for planetary asset run discovery."""

from __future__ import annotations

from pathlib import Path

VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v", ".mkv")


def list_planetary_run_dirs_with_videos(assets_dir: Path) -> list[Path]:
    """Return sorted planetary run directories that contain at least one video."""
    if not assets_dir.is_dir():
        return []

    return [
        run_dir
        for run_dir in sorted(path for path in assets_dir.iterdir() if path.is_dir())
        if list_planetary_videos(run_dir)
    ]


def list_planetary_videos(run_dir: Path) -> list[Path]:
    """Return sorted video files under ``run_dir/animations``."""
    animations_dir = run_dir / "animations"
    if not animations_dir.is_dir():
        return []

    videos: set[Path] = set()
    for extension in VIDEO_EXTENSIONS:
        videos.update(animations_dir.glob(f"*{extension}"))
        videos.update(animations_dir.glob(f"*{extension.upper()}"))

    return sorted(videos)


def find_reference_planetary_video(run_dir: Path) -> Path | None:
    """Return the first available planetary video for a run, if any."""
    videos = list_planetary_videos(run_dir)
    return videos[0] if videos else None
