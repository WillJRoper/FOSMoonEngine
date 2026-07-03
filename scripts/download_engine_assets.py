#!/usr/bin/env python3
"""Download all simulation assets referenced in an online run manifest.

Reads ``run-manifest.json`` (the online manifest with R2 public URLs) and
downloads every referenced file into the local ``public/assets/`` directory
tree, mirroring the per-run layout the app expects:

::

    public/assets/<simulation>/<run>/run_summary.yaml
    public/assets/<simulation>/<run>/live_data_table.csv
    public/assets/<simulation>/<run>/animations/<view>.mp4

Usage::

    # Download everything for all three simulation families
    python scripts/download_engine_assets.py

    # Download only cosmos assets
    python scripts/download_engine_assets.py --simulation cosmos

    # Dry-run — show what would be downloaded
    python scripts/download_engine_assets.py --dry-run

    # Download from a specific manifest path
    python scripts/download_engine_assets.py --manifest public/assets/run-manifest.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

try:
    from tqdm import tqdm
except ImportError:
    tqdm = None

ProgressBar = Any


PUBLIC_ASSETS = Path("public/assets")
DEFAULT_MANIFEST = PUBLIC_ASSETS / "run-manifest.json"
CHUNK_SIZE = 8 * 1024 * 1024  # 8 MiB
DEFAULT_HTTP_HEADERS = {
    "User-Agent": "UniverseEngineAssetDownloader/1.0 (+https://github.com/UniverseMakers)",
    "Accept": "*/*",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


def build_download_task(
    *,
    entry: dict[str, Any],
    url: str,
    backup_url: str | None,
    dest: Path,
    asset_kind: str,
    view_id: str | None = None,
) -> dict[str, str]:
    """Build one normalized download task with richer logging metadata."""
    task = {
        "simulation": str(entry.get("simulationId", "unknown")),
        "run_id": str(entry.get("runId", "unknown")),
        "asset_kind": asset_kind,
        "url": url,
        "backup_url": backup_url or "",
        "dest": str(dest),
    }

    if view_id:
        task["view_id"] = view_id

    return task


def describe_task(task: dict[str, str]) -> str:
    """Return a short human-readable label for one download task."""
    parts = [task["simulation"], task["run_id"], task["asset_kind"]]
    view_id = task.get("view_id")

    if view_id:
        parts.append(view_id)

    return " / ".join(parts)


def log_line(message: str, progress: ProgressBar | None = None, *, error: bool = False) -> None:
    """Write a log line without mangling tqdm output."""
    stream = sys.stderr if error else sys.stdout

    if progress is not None and tqdm is not None:
        tqdm.write(message, file=stream)
        return

    print(message, file=stream)


def with_cache_bust(url: str) -> str:
    """Append a throwaway query param so caches must treat the request as fresh."""
    parsed = urlparse(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)

    query.append(("_download_bust", str(time.time_ns())))
    return urlunparse(parsed._replace(query=urlencode(query)))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help=f"Path to the online run manifest (default: {DEFAULT_MANIFEST})",
    )
    parser.add_argument(
        "--simulation",
        choices=("cosmos", "galaxy", "planetary"),
        help="Only download assets for this simulation family",
    )
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=PUBLIC_ASSETS,
        help=f"Local assets root (default: {PUBLIC_ASSETS})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be downloaded without touching disk",
    )
    parser.add_argument(
        "--max-runs",
        type=int,
        help="Only include the first N matching runs (useful for testing)",
    )
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    """Load and validate the run manifest."""
    if not path.is_file():
        raise SystemExit(f"ERROR: Manifest not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict) or "runs" not in payload:
        raise SystemExit("ERROR: Manifest does not contain a 'runs' key.")
    return payload


def run_output_path(entry: dict[str, Any], assets_dir: Path) -> Path:
    """Return the local output directory for a run entry."""
    return assets_dir / entry["simulationId"] / entry["runId"]


def collect_downloads(
    manifest: dict[str, Any], simulation: str | None, assets_dir: Path, max_runs: int | None
) -> list[dict[str, str]]:
    """Build an ordered list of {url, dest_path} download tasks."""
    tasks: list[dict[str, str]] = []
    primary_base = normalize_base_url(manifest.get("primaryBase"))
    backup_base = normalize_base_url(manifest.get("backupBase"))

    matched_runs = 0

    for entry in manifest["runs"]:
        sim = entry.get("simulationId", "")
        if simulation and sim != simulation:
            continue

        run = entry.get("runId", "")
        if not run:
            continue

        matched_runs += 1
        if max_runs is not None and matched_runs > max_runs:
            break

        base = run_output_path(entry, assets_dir)

        # ── summary YAML ───────────────────────────────────────────────
        summary_url = entry.get("summaryPath", "")
        if summary_url:
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(summary_url, primary_base),
                    backup_url=resolve_asset_url(summary_url, backup_base),
                    dest=base / "run_summary.yaml",
                    asset_kind="summary",
                )
            )

        # ── live data CSV ──────────────────────────────────────────────
        live_url = entry.get("liveDataPath", "")
        if live_url:
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(live_url, primary_base),
                    backup_url=resolve_asset_url(live_url, backup_base),
                    dest=base / "live_data_table.csv",
                    asset_kind="live-data",
                )
            )

        # ── parameter YAML (if present) ────────────────────────────────
        params_url = entry.get("paramsPath") or derive_params_url(entry.get("summaryPath", ""))
        if params_url:
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(params_url, primary_base),
                    backup_url=resolve_asset_url(params_url, backup_base),
                    dest=base / "parameters.yaml",
                    asset_kind="parameters",
                )
            )

        hex_pos_url = derive_hex_pos_url(entry.get("summaryPath", ""))
        if hex_pos_url:
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(hex_pos_url, primary_base),
                    backup_url=resolve_asset_url(hex_pos_url, backup_base),
                    dest=base / "hex_pos.yaml",
                    asset_kind="hex-position",
                )
            )

        # ── optional audio track ────────────────────────────────────────
        audio_url = entry.get("audioPath")
        if audio_url:
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(audio_url, primary_base),
                    backup_url=resolve_asset_url(audio_url, backup_base),
                    dest=base / "audio_track.wav",
                    asset_kind="audio",
                )
            )

        # ── view videos ────────────────────────────────────────────────
        for view_id, video_url in entry.get("views", {}).items():
            filename = urlparse(video_url).path.rsplit("/", 1)[-1]
            tasks.append(
                build_download_task(
                    entry=entry,
                    url=resolve_asset_url(video_url, primary_base),
                    backup_url=resolve_asset_url(video_url, backup_base),
                    dest=base / "animations" / filename,
                    asset_kind="video",
                    view_id=view_id,
                )
            )

    return tasks


def normalize_base_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value.rstrip("/") + "/"


def resolve_asset_url(path_or_url: str, primary_base: str | None) -> str:
    parsed = urlparse(path_or_url)
    if parsed.scheme and parsed.netloc:
        return path_or_url
    if path_or_url.startswith("/") and primary_base:
        return urljoin(primary_base, path_or_url.lstrip("/"))
    return path_or_url


def derive_params_url(summary_path: str) -> str:
    if not isinstance(summary_path, str) or not summary_path:
        return ""

    return summary_path.replace("run_summary.yaml", "parameters.yaml")


def derive_hex_pos_url(summary_path: str) -> str:
    if not isinstance(summary_path, str) or not summary_path:
        return ""

    return summary_path.replace("run_summary.yaml", "hex_pos.yaml")


def format_size(num_bytes: int) -> str:
    """Format a byte count for terminal output."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num_bytes) < 1024:
            return f"{num_bytes:.0f} {unit}"
        num_bytes /= 1024
    return f"{num_bytes:.1f} TB"


def download_file(task: dict[str, str], dry_run: bool, progress: ProgressBar | None = None) -> bool:
    """Download one file.  Returns True on success (or dry-run)."""
    url = task["url"]
    backup_url = task.get("backup_url") or None
    dest = task["dest"]
    dest_path = Path(dest)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_name(f"{dest_path.name}.part")
    label = describe_task(task)

    if dry_run:
        log_line(f"  [DRY-RUN] {label}\n    {url}\n    -> {dest_path}", progress)
        return True

    candidates = [url]
    if backup_url and backup_url != url:
        candidates.append(backup_url)

    for index, candidate in enumerate(candidates):
        try:
            candidate_url = with_cache_bust(candidate)
            request = Request(candidate_url, headers=DEFAULT_HTTP_HEADERS)
            with urlopen(request) as response:
                length = response.headers.get("Content-Length")
                total = int(length) if length else None
                downloaded = 0
                start = time.monotonic()

                tmp_path.unlink(missing_ok=True)

                if progress is not None:
                    progress.set_postfix_str(label)

                with tmp_path.open("wb") as out:
                    while True:
                        chunk = response.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        out.write(chunk)
                        downloaded += len(chunk)

                if total is not None and downloaded != total:
                    raise IOError(
                        f"downloaded size mismatch: expected {total} bytes, got {downloaded}"
                    )

                tmp_path.replace(dest_path)

                elapsed = time.monotonic() - start
                rate = (downloaded / elapsed / 1_048_576) if elapsed > 0 else 0
                msg = f"  {format_size(downloaded)}"
                if total and total > 0:
                    msg += f" / {format_size(total)}"
                suffix = " (backup)" if index > 0 else ""
                log_line(f"{msg}  {rate:.0f} MiB/s  {label}{suffix}", progress)
                return True
        except Exception as exc:
            tmp_path.unlink(missing_ok=True)
            if index == len(candidates) - 1:
                log_line(
                    f"  FAILED  {label}\n    {candidate}\n    ({exc})",
                    progress,
                    error=True,
                )
                if dest_path.exists() and dest_path.stat().st_size == 0:
                    dest_path.unlink(missing_ok=True)
                return False
            continue

    return False
def main() -> None:
    args = parse_args()
    manifest = load_manifest(args.manifest.expanduser().resolve())
    assets_dir = args.assets_dir.expanduser().resolve()

    if args.max_runs is not None and args.max_runs <= 0:
        raise SystemExit("--max-runs must be a positive integer")

    tasks = collect_downloads(manifest, args.simulation, assets_dir, args.max_runs)

    if not tasks:
        sim_msg = f" for '{args.simulation}'" if args.simulation else ""
        print(f"No download tasks found{sim_msg} in {args.manifest}")
        return

    run_ids = {(task["simulation"], task["run_id"]) for task in tasks}
    simulations = Counter(task["simulation"] for task in tasks)
    print(f"Downloading {len(tasks)} files to {assets_dir}")
    print(f"Matched {len(run_ids)} runs across {len(simulations)} simulation families")
    for simulation_id, count in sorted(simulations.items()):
        print(f"  - {simulation_id}: {count} files")
    print()

    if args.dry_run:
        print("DRY-RUN MODE — no files will be written\n")

    succeeded = 0
    failed = 0

    task_iterable = tasks
    overall_progress = None
    if tqdm is not None and not args.dry_run and sys.stderr.isatty():
        overall_progress = tqdm(tasks, desc="Files", unit="file", dynamic_ncols=True)
        task_iterable = overall_progress

    current_run: tuple[str, str] | None = None

    for task in task_iterable:
        run_key = (task["simulation"], task["run_id"])
        if run_key != current_run:
            current_run = run_key
            log_line(f"\n[{task['simulation']}] run {task['run_id']}", overall_progress)

        ok = download_file(task, args.dry_run, overall_progress)
        if ok:
            succeeded += 1
        else:
            failed += 1

    if overall_progress is not None:
        overall_progress.set_postfix_str("")
        overall_progress.close()

    print()
    print(f"Done. {succeeded} succeeded, {failed} failed.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
