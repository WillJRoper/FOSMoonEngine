#!/usr/bin/env python3
"""Print a readable summary of a run manifest and optionally generate plots.

Usage:

    python3 scripts/summarize_manifest.py public/assets/local-manifest.json
    python3 scripts/summarize_manifest.py public/assets/local-manifest.json --plots plots/

The ``--plots`` flag produces one sub-directory per simulation family containing:
  - ``histograms.png``  — one histogram per parameter, side-by-side.
  - ``scatter.png``     — pairwise scatter matrix (corner plot) of all parameters.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOT = REPO_ROOT / "public"
PARAM_INFO_PATH = REPO_ROOT / "src" / "selection" / "parameter-info.yaml"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Path to manifest JSON file")
    parser.add_argument(
        "--plots",
        type=Path,
        default=None,
        help="Directory to write summary plots into.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest_path = args.manifest.expanduser().resolve()
    manifest = load_manifest(manifest_path)
    runs = manifest.get("runs", [])

    if not isinstance(runs, list):
        raise SystemExit("Manifest 'runs' field must be a list")

    param_limits = load_param_limits()

    scale_counts: Counter[str] = Counter()
    video_counts_by_scale: Counter[str] = Counter()
    video_counts_by_type: Counter[str] = Counter()
    views_per_run: Counter[int] = Counter()
    unique_view_ids_by_scale: dict[str, set[str]] = defaultdict(set)
    parameter_counts: Counter[int] = Counter()
    runs_missing_default_view = 0
    duplicate_run_ids: Counter[str] = Counter()
    params_by_scale: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list),
    )
    range_violations: list[tuple[str, str, str, float, float, float]] = []
    missing_assets: list[tuple[str, str, str, str]] = []

    total_videos = 0

    for run in runs:
        if not isinstance(run, dict):
            continue

        simulation_id = str(run.get("simulationId", "unknown"))
        run_id = str(run.get("runId", "unknown"))
        parameters = run.get("parameters", {})
        views = run.get("views", {})
        default_view = run.get("defaultView")

        scale_counts[simulation_id] += 1
        duplicate_run_ids[run_id] += 1

        if isinstance(parameters, dict):
            parameter_counts[len(parameters)] += 1
            limits = param_limits.get(simulation_id, {})
            for key, value in parameters.items():
                if isinstance(value, (int, float)):
                    params_by_scale[simulation_id][key].append(float(value))
                    param_range = limits.get(key)
                    if param_range:
                        min_val, max_val = param_range
                        if value < min_val or value > max_val:
                            range_violations.append(
                                (simulation_id, run_id, key, value, min_val, max_val),
                            )

        if not isinstance(views, dict):
            continue

        missing_assets.extend(
            collect_missing_assets(
                manifest_path=manifest_path,
                simulation_id=simulation_id,
                run_id=run_id,
                live_data_path=run.get("liveDataPath"),
                summary_path=run.get("summaryPath"),
                views=views,
            )
        )

        view_count = len(views)
        total_videos += view_count
        video_counts_by_scale[simulation_id] += view_count
        views_per_run[view_count] += 1

        for view_id in views:
            view_name = str(view_id)
            video_counts_by_type[view_name] += 1
            unique_view_ids_by_scale[simulation_id].add(view_name)

        if default_view not in views:
            runs_missing_default_view += 1

    duplicate_run_ids = Counter(
        {run_id: count for run_id, count in duplicate_run_ids.items() if count > 1},
    )

    print(f"Manifest: {manifest_path}")
    print(f"Version: {manifest.get('version', 'unknown')}")
    print()
    print("Overview")
    print(f"- Total runs: {len(runs):,}")
    print(f"- Total videos: {total_videos:,}")
    print(f"- Average videos per run: {total_videos / max(len(runs), 1):.2f}")
    print(f"- Runs missing valid defaultView: {runs_missing_default_view:,}")
    print()
    print("Runs By Scale")
    for scale, count in sorted(scale_counts.items()):
        print(f"- {scale}: {count:,} runs")
    print()
    print("Videos By Scale")
    for scale, count in sorted(video_counts_by_scale.items()):
        print(f"- {scale}: {count:,} videos")
    print()
    print("Videos By Type")
    for view_id, count in sorted(video_counts_by_type.items()):
        print(f"- {view_id}: {count:,}")
    print()
    print("Views Per Run")
    for view_count, run_count in sorted(views_per_run.items()):
        suffix = "video" if view_count == 1 else "videos"
        print(f"- {run_count:,} runs have {view_count} {suffix}")
    print()
    print("Parameter Count Distribution")
    for param_count, run_count in sorted(parameter_counts.items()):
        suffix = "parameter" if param_count == 1 else "parameters"
        print(f"- {run_count:,} runs have {param_count} {suffix}")
    print()
    print("View Types By Scale")
    for scale, view_ids in sorted(unique_view_ids_by_scale.items()):
        labels = ", ".join(sorted(view_ids)) if view_ids else "(none)"
        print(f"- {scale}: {labels}")

    if duplicate_run_ids:
        print()
        print("Duplicate Run IDs")
        for run_id, count in sorted(duplicate_run_ids.items()):
            print(f"- {run_id}: {count} entries")

    if range_violations:
        print()
        print(f"PARAMETER RANGE VIOLATIONS ({len(range_violations)} found)")
        print("  These parameters lie outside the limits defined in parameter-info.yaml:")
        print()
        for scale, run_id, param, value, min_val, max_val in range_violations:
            direction = "below" if value < min_val else "above"
            print(f"  {scale}/{run_id}  {param}={value}  ({direction} [{min_val}, {max_val}])")

    if missing_assets:
        print()
        print(f"MISSING MANIFEST ASSETS ({len(missing_assets)} found)")
        print("  These manifest entries point to files that do not exist locally:")
        print()
        for scale, run_id, asset_kind, asset_path in missing_assets:
            print(f"  {scale}/{run_id}  {asset_kind}: {asset_path}")

    if args.plots:
        generate_plots(args.plots, params_by_scale)


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Manifest file does not exist: {path}")

    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    if not isinstance(data, dict):
        raise SystemExit("Manifest root must be a JSON object")

    return data


def load_param_limits() -> dict[str, dict[str, tuple[float, float]]]:
    """Parse parameter-info.yaml and return {scale: {param_id: (min, max)}}."""
    if not PARAM_INFO_PATH.exists():
        print(f"Warning: {PARAM_INFO_PATH} not found — skipping range checks")
        return {}

    raw = yaml.safe_load(PARAM_INFO_PATH.read_text(encoding="utf-8"))
    limits: dict[str, dict[str, tuple[float, float]]] = {}

    for scale, params in raw.items():
        if not isinstance(params, dict):
            continue
        scale_limits: dict[str, tuple[float, float]] = {}
        for param_id, param_def in params.items():
            if not isinstance(param_def, dict):
                continue
            if "min" in param_def and "max" in param_def:
                scale_limits[param_id] = (
                    float(param_def["min"]),
                    float(param_def["max"]),
                )
        if scale_limits:
            limits[scale] = scale_limits

    return limits


def collect_missing_assets(
    *,
    manifest_path: Path,
    simulation_id: str,
    run_id: str,
    live_data_path: Any,
    summary_path: Any,
    views: dict[Any, Any],
) -> list[tuple[str, str, str, str]]:
    missing: list[tuple[str, str, str, str]] = []

    for asset_kind, asset_path in (
        ("liveDataPath", live_data_path),
        ("summaryPath", summary_path),
    ):
        if isinstance(asset_path, str) and not resolve_manifest_path(manifest_path, asset_path).exists():
            missing.append((simulation_id, run_id, asset_kind, asset_path))

    for view_id, view_path in views.items():
        if not isinstance(view_path, str):
            continue
        if not resolve_manifest_path(manifest_path, view_path).exists():
            missing.append((simulation_id, run_id, f"view:{view_id}", view_path))

    return missing


def resolve_manifest_path(manifest_path: Path, asset_path: str) -> Path:
    candidate = Path(asset_path)

    if candidate.is_absolute():
        return candidate

    if candidate.parts and candidate.parts[0] == "assets":
        return PUBLIC_ROOT / candidate

    return manifest_path.parent / candidate


def generate_plots(
    out_dir: Path,
    params_by_scale: dict[str, dict[str, list[float]]],
) -> None:
    """Write histogram and scatter plots for each simulation family."""
    try:
        import matplotlib.pyplot as plt  # noqa: F811
    except ImportError:
        raise SystemExit(
            "matplotlib is required for plot generation.  "
            "Install it with: pip install matplotlib",
        )

    out_dir.mkdir(parents=True, exist_ok=True)

    for scale, param_map in sorted(params_by_scale.items()):
        if not param_map:
            continue

        param_names = sorted(param_map.keys())
        scale_dir = out_dir / scale
        scale_dir.mkdir(parents=True, exist_ok=True)

        # ── Histograms ──────────────────────────────────────────────────
        cols = min(len(param_names), 3)
        rows = (len(param_names) + cols - 1) // cols
        fig, axes = plt.subplots(
            rows,
            cols,
            figsize=(cols * 4.5, rows * 3.5),
            squeeze=False,
        )

        for idx, name in enumerate(param_names):
            ax = axes[idx // cols][idx % cols]
            values = param_map[name]
            ax.hist(values, bins=min(len(set(values)), 20), edgecolor="white", alpha=0.75)
            ax.set_title(name.replace("_", " ").title(), fontsize=11)
            ax.set_xlabel("Value")
            ax.set_ylabel("Count")

        # Hide unused subplot slots.
        for idx in range(len(param_names), rows * cols):
            axes[idx // cols][idx % cols].set_visible(False)

        fig.suptitle(f"{scale.title()} — Parameter Histograms", fontsize=13, y=1.02)
        fig.tight_layout()
        hist_path = scale_dir / "histograms.png"
        fig.savefig(hist_path, dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"  wrote {hist_path}")

        # ── Scatter matrix (corner plot) ────────────────────────────────
        if len(param_names) < 2:
            continue

        n = len(param_names)
        fig, axes = plt.subplots(
            n,
            n,
            figsize=(n * 3.5, n * 3.5),
            squeeze=False,
        )

        for row in range(n):
            for col in range(n):
                ax = axes[row][col]
                ax.tick_params(labelsize=7)

                if col > row:
                    ax.set_visible(False)
                elif col == row:
                    # Diagonal: histogram of single parameter.
                    values = param_map[param_names[row]]
                    ax.hist(
                        values,
                        bins=min(len(set(values)), 15),
                        edgecolor="white",
                        alpha=0.75,
                    )
                    if row == n - 1:
                        ax.set_xlabel(param_names[row].replace("_", " ").title(), fontsize=8)
                else:
                    # Lower triangle: scatter of param[col] vs param[row].
                    x_vals = param_map[param_names[col]]
                    y_vals = param_map[param_names[row]]
                    ax.scatter(x_vals, y_vals, s=12, alpha=0.6, edgecolors="none")
                    if row == n - 1:
                        ax.set_xlabel(param_names[col].replace("_", " ").title(), fontsize=8)
                    if col == 0:
                        ax.set_ylabel(param_names[row].replace("_", " ").title(), fontsize=8)

        fig.suptitle(
            f"{scale.title()} — Parameter Scatter Matrix",
            fontsize=13,
            y=1.02,
        )
        fig.tight_layout()
        scatter_path = scale_dir / "scatter.png"
        fig.savefig(scatter_path, dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"  wrote {scatter_path}")


if __name__ == "__main__":
    main()
