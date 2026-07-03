#!/usr/bin/env python3
"""Generate the run manifest consumed by the frontend.

Modes:

* ``--local``: scan ``public/assets/<family>/`` (or ``--assets-dir``) and write
  ``public/assets/local-manifest.json``.
* default: scan the actual R2 bucket contents below ``engine/`` and write
  ``public/assets/run-manifest.json``.

Refresh any per-family metadata first so each run directory already contains
current ``parameters.yaml`` and ``run_summary.yaml`` files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOT = REPO_ROOT / "public"
ASSET_ROOT = PUBLIC_ROOT / "assets"
LOCAL_MANIFEST_PATH = ASSET_ROOT / "local-manifest.json"
ONLINE_MANIFEST_PATH = ASSET_ROOT / "run-manifest.json"
R2_ENGINE_PREFIX = "engine"

SIMULATION_DIRECTORIES = ("planetary", "galaxy", "cosmos")

SKIP_NAMES = frozenset({".DS_Store", "__pycache__", ".ipynb_checkpoints"})

VIDEO_EXTENSIONS = frozenset({".mp4", ".webm", ".mov", ".mkv"})

METADATA_EXTENSIONS = frozenset({".csv", ".yaml", ".yml", ".json", ".txt", ".html", ".wav"})

STATIC_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".svg"})
# Filename patterns that should never be uploaded (debug artifacts, build-time
# intermediate files, comparison grids not consumed by the frontend).
_UPLOAD_SKIP_FILENAMES = frozenset(
    {"all_videos_comparison_2x2.mp4", "final_snapshot_summary.csv"}
)
_UPLOAD_SKIP_PATTERNS = (
    "live_data_table_L",  # debug-res HTML/CSV telemetry variants
)

# Legacy fallback for run directories that do not yet have a
# ``parameters.yaml``. When the YAML is present it takes precedence over
# token-based parsing.
RUN_TOKEN_MAP: dict[str, dict[str, str]] = {
    "cosmos": {
        "Fb": "baryon_fraction",
        "AGN": "black_hole_strength",
        "G": "gravity_strength",
    },
}

SUMMARY_PARAMETER_IDS: dict[str, tuple[str, ...]] = {
    "galaxy": ("stellar_mass", "black_hole_mass", "galaxy_age"),
}


def discover_runs(
    assets_root: Path | None = None,
    themes: tuple[str, ...] = SIMULATION_DIRECTORIES,
) -> dict[str, list[Path]]:
    """Return theme name -> sorted list of run directory Paths.

    Only directories that contain at least one non-skipped file
    (recursively) are considered runs.

    This function is reused by the R2 upload script to avoid duplicating
    directory-walking logic.

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
            if any(
                p.is_file() and not _should_skip_file(p)
                for p in entry.rglob("*")
            ):
                runs.append(entry)
        if runs:
            result[theme] = runs

    return result


def discover_files_for_upload(
    assets_root: Path,
    themes: tuple[str, ...] = SIMULATION_DIRECTORIES,
) -> dict[str, dict[str, dict[str, list[Path]]]]:
    """Walk the assets tree and return files grouped for upload.

    Args:
        assets_root: Root of the asset tree.
        themes: Simulation family directory names to scan.

    Returns:
        Nested dict of the form::

            {
                "theme_name": {
                    "run_name": {
                        "animations": [Path, ...],
                        "metadata": [Path, ...],
                    }
                }
            }

        Only files that should be uploaded are included; junk files, hidden
        files, and bare directories are excluded.
    """
    result: dict[str, dict[str, dict[str, list[Path]]]] = {}

    discovered = discover_runs(assets_root, themes)

    for theme, run_dirs in discovered.items():
        theme_entry: dict[str, dict[str, list[Path]]] = {}
        for run_dir in run_dirs:
            animations: list[Path] = []
            metadata: list[Path] = []
            for file_path in sorted(run_dir.rglob("*")):
                if not file_path.is_file():
                    continue
                if _should_skip_file(file_path):
                    continue
                rel = file_path.relative_to(run_dir)
                if rel.parts[0] == "animations":
                    animations.append(file_path)
                else:
                    metadata.append(file_path)
            if animations or metadata:
                theme_entry[run_dir.name] = {
                    "animations": animations,
                    "metadata": metadata,
                }
        if theme_entry:
            result[theme] = theme_entry

    return result


def _should_skip_file(path: Path) -> bool:
    """Return True if the file should not be uploaded or published.

    Args:
        path: File path to check.

    Returns:
        True if the file matches skip patterns or has an unrecognised
        extension.
    """
    name = path.name
    if name in SKIP_NAMES or name.endswith(".pyc") or name.startswith("."):
        return True
    for part in path.parts:
        if part in SKIP_NAMES or part.startswith("."):
            return True
    if name in _UPLOAD_SKIP_FILENAMES:
        return True
    if any(name.startswith(pat) for pat in _UPLOAD_SKIP_PATTERNS):
        return True
    ext = path.suffix.lower()
    return (
        ext not in VIDEO_EXTENSIONS
        and ext not in METADATA_EXTENSIONS
        and ext not in STATIC_EXTENSIONS
    )


def main() -> None:
    """Entry point: scan run directories and write the selected manifest."""
    args = parse_args()
    output_path = LOCAL_MANIFEST_PATH if args.local else ONLINE_MANIFEST_PATH
    manifest = build_manifest(args)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(output_path)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed CLI namespace.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local",
        action="store_true",
        help="Generate a local manifest using public/assets-relative paths.",
    )
    parser.add_argument(
        "--assets-dir",
        type=Path,
        help="Override the local assets root to scan when using --local.",
    )
    return parser.parse_args()


def build_path_builder(args: argparse.Namespace) -> Callable[[Path], str]:
    """Return the path-to-manifest string converter for this invocation.

    Args:
        args: Parsed CLI arguments.

    Returns:
        Callable converting concrete filesystem paths into manifest paths.
    """
    if args.local and args.assets_dir is not None:
        assets_root = resolve_local_assets_root(args)
        return lambda path: to_assets_relative_path(path, assets_root)

    return to_public_relative_path


def build_manifest(
    args: argparse.Namespace,
) -> dict[str, object]:
    """Build the frontend run manifest from either local files or R2."""
    if not args.local:
        manifest: dict[str, object] = {
            "version": 1,
            "primaryBase": _env_or_die("R2_PUBLIC_BASE").rstrip("/"),
            "backupBase": _env_or_die("R2_BACKUP_BASE").rstrip("/"),
            "runs": [],
        }
        for entry in build_manifest_entries_from_r2(args):
            manifest["runs"].append(entry)  # type: ignore[union-attr]
        return manifest

    manifest = {"version": 1, "runs": []}

    assets_root = resolve_local_assets_root(args)
    path_builder = build_path_builder(args)
    for simulation_id in SIMULATION_DIRECTORIES:
        sim_root = assets_root / simulation_id
        if not sim_root.exists():
            continue

        for run_dir in iter_local_run_dirs(sim_root):
            entry = build_manifest_entry(simulation_id, run_dir, path_builder)
            if entry is not None:
                manifest["runs"].append(entry)  # type: ignore[union-attr]

    return manifest


def iter_local_run_dirs(sim_root: Path) -> list[Path]:
    """Return nested run directories below one simulation family root.

    A run directory is any directory that contains at least one animation video
    somewhere under ``animations/``. This allows local assets to be discovered
    whether they live directly under the simulation root or inside nested
    grouping directories.
    """

    run_dirs: list[Path] = []

    for path in sorted(sim_root.rglob("*")):
        if not path.is_dir():
            continue
        if path.name in SKIP_NAMES or path.name.startswith("."):
            continue

        animations_dir = path / "animations"
        if animations_dir.exists() and any(animations_dir.glob("*.mp4")):
            run_dirs.append(path)

    return run_dirs


def resolve_local_assets_root(args: argparse.Namespace) -> Path:
    """Return the local assets root used for ``--local`` manifest generation."""
    if args.assets_dir is None:
        return ASSET_ROOT

    assets_root = args.assets_dir.expanduser().resolve()
    if not assets_root.is_dir():
        raise SystemExit(f"ERROR: assets directory does not exist: {assets_root}")

    return assets_root


def build_manifest_entry(
    simulation_id: str,
    run_dir: Path,
    path_builder: Callable[[Path], str],
) -> dict[str, Any] | None:
    """Build a single manifest entry for one run directory.

    Args:
        simulation_id: Simulation family name (e.g. "cosmos").
        run_dir: Path to the run's directory.

    Returns:
        Manifest entry dict, or None if the run has no video files.
    """
    animations_dir = run_dir / "animations"
    videos = (
        sorted(animations_dir.glob("*.mp4"))
        if animations_dir.exists()
        else []
    )
    if not videos:
        return None

    live_data_path = run_dir / "live_data_table.csv"
    run_summary_yaml = run_dir / "run_summary.yaml"
    parameters_yaml = run_dir / "parameters.yaml"
    audio_track = run_dir / "audio_track.wav"

    view_paths = {
        infer_view_id(video): path_builder(video)
        for video in videos
    }
    default_view = pick_default_view(view_paths)

    entry = {
        "simulationId": simulation_id,
        "runId": run_dir.name,
        "parameters": parse_run_parameters(simulation_id, run_dir),
        "liveDataPath": path_builder(live_data_path),
        "summaryPath": path_builder(run_summary_yaml),
        "defaultView": default_view,
        "views": view_paths,
    }

    if parameters_yaml.exists():
        entry["paramsPath"] = path_builder(parameters_yaml)

    if audio_track.exists():
        entry["audioPath"] = path_builder(audio_track)

    thumbnail_path = find_gallery_thumbnail(run_dir)
    if thumbnail_path is not None:
        entry["thumbnailPath"] = path_builder(thumbnail_path)

    return entry


def find_gallery_thumbnail(run_dir: Path) -> Path | None:
    """Return the preferred gallery thumbnail file for one run directory."""

    for filename in (
        "gallery-thumbnail.png",
        "gallery-thumbnail.webp",
        "gallery-thumbnail.jpg",
        "gallery-thumbnail.jpeg",
    ):
        candidate = run_dir / filename
        if candidate.exists():
            return candidate

    return None


def build_manifest_entries_from_r2(
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    """Build manifest entries by scanning object keys from an R2 bucket."""
    _ = args
    bucket = os.environ.get("R2_BUCKET", "").strip()
    if not bucket:
        raise SystemExit(
            "ERROR: R2_BUCKET must be set when generating the online manifest."
        )

    _env_or_die("R2_PUBLIC_BASE")
    _env_or_die("R2_BACKUP_BASE")

    s3 = create_r2_client(
        _env_or_die("R2_ACCOUNT_ID"),
        _env_or_die("R2_ACCESS_KEY_ID"),
        _env_or_die("R2_SECRET_ACCESS_KEY"),
    )
    objects_by_run = list_r2_run_objects(s3, bucket, R2_ENGINE_PREFIX)
    entries: list[dict[str, Any]] = []

    for simulation_id in SIMULATION_DIRECTORIES:
        runs = objects_by_run.get(simulation_id, {})
        for run_id in sorted(runs):
            entry = build_manifest_entry_from_r2(
                simulation_id=simulation_id,
                run_id=run_id,
                object_keys=runs[run_id],
                object_prefix=R2_ENGINE_PREFIX,
                bucket=bucket,
                s3=s3,
            )
            if entry is not None:
                entries.append(entry)

    return entries


def build_manifest_entry_from_r2(
    *,
    simulation_id: str,
    run_id: str,
    object_keys: list[str],
    object_prefix: str,
    bucket: str,
    s3: Any,
) -> dict[str, Any] | None:
    """Build one frontend manifest entry from a set of remote object keys."""
    video_keys = sorted(
        key
        for key in object_keys
        if key.endswith(".mp4") and "/animations/" in key
    )
    if not video_keys:
        return None

    run_root = _strip_run_relative_path(video_keys[0], "animations/")
    live_data_key = f"{run_root}live_data_table.csv"
    summary_key = f"{run_root}run_summary.yaml"
    parameter_key = f"{run_root}parameters.yaml"
    audio_key = f"{run_root}audio_track.wav"

    view_paths = {
        infer_view_id(Path(video_key)): to_manifest_asset_path(object_prefix, video_key)
        for video_key in video_keys
    }
    default_view = pick_default_view(view_paths)

    entry = {
        "simulationId": simulation_id,
        "runId": run_id,
        "parameters": parse_r2_run_parameters(
            simulation_id=simulation_id,
            run_id=run_id,
            object_prefix=object_prefix,
            parameter_key=parameter_key,
            summary_key=summary_key,
            object_keys=object_keys,
            bucket=bucket,
            s3=s3,
        ),
        "liveDataPath": to_manifest_asset_path(object_prefix, live_data_key),
        "summaryPath": to_manifest_asset_path(object_prefix, summary_key),
        "defaultView": default_view,
        "views": view_paths,
    }

    if parameter_key in object_keys:
        entry["paramsPath"] = to_manifest_asset_path(object_prefix, parameter_key)

    if audio_key in object_keys:
        entry["audioPath"] = to_manifest_asset_path(object_prefix, audio_key)

    return entry


def parse_run_parameters(
    simulation_id: str, run_dir: Path
) -> dict[str, float]:
    """Read run parameters from ``parameters.yaml`` or parse directory name.

    Args:
        simulation_id: Simulation family name.
        run_dir: Path to the run's directory.

    Returns:
        Mapping of parameter id -> value.
    """
    params_yaml = run_dir / "parameters.yaml"
    if params_yaml.exists():
        with params_yaml.open("r", encoding="utf-8") as handle:
            raw: dict[str, Any] = yaml.safe_load(handle) or {}
        return {str(k): float(v) for k, v in raw.items()}

    summary_params = _parse_run_parameters_from_summary_yaml(
        simulation_id, run_dir / "run_summary.yaml"
    )
    if summary_params:
        return summary_params

    return _parse_run_parameters_from_tokens(simulation_id, run_dir.name)


def parse_r2_run_parameters(
    *,
    simulation_id: str,
    run_id: str,
    object_prefix: str,
    parameter_key: str,
    summary_key: str,
    object_keys: list[str],
    bucket: str,
    s3: Any,
) -> dict[str, float]:
    """Read run parameters from a remote parameters.yaml or run-id tokens."""
    if parameter_key in object_keys:
        try:
            response = s3.get_object(
                Bucket=bucket,
                Key=to_r2_object_key(object_prefix, parameter_key),
            )
            payload = response["Body"].read().decode("utf-8")
            raw: dict[str, Any] = yaml.safe_load(payload) or {}
            return {str(k): float(v) for k, v in raw.items()}
        except Exception:
            pass

    if summary_key in object_keys:
        try:
            response = s3.get_object(
                Bucket=bucket,
                Key=to_r2_object_key(object_prefix, summary_key),
            )
            payload = response["Body"].read().decode("utf-8")
            summary_params = _parse_run_parameters_from_summary_payload(
                simulation_id, payload
            )
            if summary_params:
                return summary_params
        except Exception:
            pass

    return _parse_run_parameters_from_tokens(simulation_id, run_id)


def _parse_run_parameters_from_summary_yaml(
    simulation_id: str, summary_path: Path
) -> dict[str, float]:
    """Recover parameters from a local ``run_summary.yaml`` when needed."""
    if not summary_path.exists():
        return {}

    with summary_path.open("r", encoding="utf-8") as handle:
        return _parse_run_parameters_from_summary_payload(
            simulation_id, handle.read()
        )


def _parse_run_parameters_from_summary_payload(
    simulation_id: str, payload: str
) -> dict[str, float]:
    """Recover parameters from a summary YAML payload's ``summaryMetrics``."""
    parameter_ids = SUMMARY_PARAMETER_IDS.get(simulation_id, ())
    if not parameter_ids:
        return {}

    raw: dict[str, Any] = yaml.safe_load(payload) or {}
    summary_metrics = raw.get("summaryMetrics")
    if not isinstance(summary_metrics, dict):
        return {}

    parsed: dict[str, float] = {}
    for parameter_id in parameter_ids:
        metric = summary_metrics.get(parameter_id)
        if not isinstance(metric, dict):
            continue
        value = metric.get("value")
        if value is None:
            continue
        try:
            parsed[parameter_id] = float(value)
        except (TypeError, ValueError):
            continue

    return parsed


def _parse_run_parameters_from_tokens(
    simulation_id: str, run_id: str
) -> dict[str, float]:
    """Legacy fallback: parse parameters from a tokenised directory name.

    Args:
        simulation_id: Simulation family name (used to look up the token map).
        run_id: Directory name containing tokenised parameters.

    Returns:
        Mapping of parameter id -> value.
    """
    token_map = RUN_TOKEN_MAP.get(simulation_id, {})
    parsed: dict[str, float] = {}

    for token in parse_parameter_tokens(run_id):
        parameter_id = token_map.get(token["prefix"])
        if parameter_id is None:
            continue
        parsed[parameter_id] = token["value"]

    return parsed


def parse_parameter_tokens(run_id: str) -> list[dict[str, str | float]]:
    """Extract parameter tokens from a run directory name.

    Tokens are of the form ``PrefixValue`` (e.g. ``Fb1.5_Ef2.0``).

    Args:
        run_id: Directory name.

    Returns:
        List of dicts with ``prefix`` (str) and ``value`` (float) keys.
    """
    tokens: list[dict[str, str | float]] = []
    for chunk in run_id.split("_"):
        match = re.fullmatch(r"([A-Za-z]+)([-+]?\d+(?:\.\d+)?)", chunk)
        if not match:
            continue
        tokens.append(
            {
                "prefix": match.group(1),
                "value": float(match.group(2)),
            }
        )
    return tokens


def create_r2_client(account_id: str, access_key: str, secret_key: str) -> Any:
    """Return a boto3 S3 client pointed at the R2 endpoint."""
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError:
        print(
            "ERROR: boto3 is not installed. Install it with:\n"
            "  pip install boto3",
            file=sys.stderr,
        )
        sys.exit(1)

    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=BotoConfig(
            region_name="auto",
            retries={"max_attempts": 3, "mode": "standard"},
            s3={"addressing_style": "path"},
        ),
    )


def list_r2_run_objects(
    s3: Any,
    bucket: str,
    prefix: str,
) -> dict[str, dict[str, list[str]]]:
    """Group remote object keys by simulation id and run id."""
    objects_by_run: dict[str, dict[str, list[str]]] = {}
    paginator = s3.get_paginator("list_objects_v2")
    scan_prefix = f"{prefix}/" if prefix else ""

    for page in paginator.paginate(Bucket=bucket, Prefix=scan_prefix):
        for obj in page.get("Contents", []):
            key = str(obj.get("Key") or "")
            relative_key = key[len(scan_prefix) :] if scan_prefix and key.startswith(scan_prefix) else key
            parts = relative_key.split("/")
            if len(parts) < 3:
                continue
            simulation_id = parts[0]
            run_id = parts[1]
            if simulation_id not in SIMULATION_DIRECTORIES:
                continue
            objects_by_run.setdefault(simulation_id, {}).setdefault(run_id, []).append(relative_key)

    return objects_by_run


def to_public_object_url(public_base: str, object_key: str) -> str:
    """Join a public base URL to a relative object key."""
    return f"{public_base}/{object_key.lstrip('/')}"


def to_manifest_asset_path(prefix: str, object_key: str) -> str:
    """Return a host-agnostic manifest path rooted at the public engine prefix."""
    prefix = prefix.strip("/")
    object_key = object_key.lstrip("/")
    if prefix:
        return f"/{prefix}/{object_key}"
    return f"/{object_key}"


def to_r2_object_key(prefix: str, object_key: str) -> str:
    """Join an R2 prefix to a relative object key for bucket API calls."""
    prefix = prefix.strip("/")
    object_key = object_key.lstrip("/")
    if prefix:
        return f"{prefix}/{object_key}"
    return object_key


def _strip_run_relative_path(object_key: str, marker: str) -> str:
    """Return the run-root prefix of an object key up to a known marker."""
    before, _sep, _after = object_key.partition(marker)
    return f"{before}"


def _env_or_die(name: str) -> str:
    """Read a required env var or exit with a helpful message."""
    value = os.environ.get(name, "").strip()
    if not value:
        print(
            f"ERROR: Environment variable {name} is not set.\n"
            f"Set it before running this script, e.g.:\n"
            f"  export {name}=<value>",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def infer_view_id(video_path: Path) -> str:
    """Map a video filename to its frontend view id.

    Args:
        video_path: Path to the video file.

    Returns:
        View id string (e.g. "gas_density").
    """
    name = video_path.stem
    if name == "Gas_Density":
        return "gas_density"
    if name == "Gas_Temperature":
        return "gas_temperature"
    if name == "DM_Density":
        return "dark_matter_density"
    if name == "Gas_Metallicity_plus_Stellar_Density":
        return "gas_metallicity_plus_stellar_density"
    return normalize_key(name)


def pick_default_view(view_paths: dict[str, str]) -> str:
    """Pick the default view from a set of available views.

    Prefers ``gas_density`` when available; otherwise returns the first key.

    Args:
        view_paths: Mapping of view id -> relative path.

    Returns:
        The default view id.
    """
    if "gas_density" in view_paths:
        return "gas_density"
    return next(iter(view_paths))


def to_public_relative_path(path: Path) -> str:
    """Convert an absolute path to a path relative to ``public/``.

    Args:
        path: Absolute filesystem path.

    Returns:
        POSIX-style relative path string.
    """
    return path.relative_to(PUBLIC_ROOT).as_posix()


def to_assets_relative_path(path: Path, assets_root: Path) -> str:
    """Convert a path under an assets root to ``assets/...`` form."""
    return (Path("assets") / path.relative_to(assets_root)).as_posix()


def normalize_key(label: str) -> str:
    """Convert a label string to a lowercase snake_case key.

    Args:
        label: A human-readable label.

    Returns:
        Normalised key.
    """
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return re.sub(r"_+", "_", normalized)


if __name__ == "__main__":
    main()
