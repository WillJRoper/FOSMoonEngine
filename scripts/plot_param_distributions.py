#!/usr/bin/env python3
"""Plot parameter distribution diagnostics from D1 tracking data.

Queries the run_selections table and generates:

a) Histogram grids — one figure per simulation family, each parameter in its
   own subplot showing how often each value was selected.
b) Time-series diagnostics — one figure per family with daily distribution
   evolution per parameter plus a runs-per-day bar chart.

Usage:
    python3 scripts/plot_param_distributions.py
    python3 scripts/plot_param_distributions.py --remote
    python3 scripts/plot_param_distributions.py --out plots/
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np

# ── Configuration ───────────────────────────────────────────────────────────

DB_NAME = "universe-engine-db"
QUERY = "SELECT created_at, simulation_id, parameters_json FROM run_selections ORDER BY created_at ASC"

FAMILY_LABELS: dict[str, str] = {
    "planetary": "Planetary",
    "galaxy": "Galaxy",
    "cosmos": "Cosmos",
}

FAMILY_COLORS: dict[str, str] = {
    "planetary": "#00ff41",
    "galaxy": "#00bfff",
    "cosmos": "#ff6b35",
}

# ── Data fetching ───────────────────────────────────────────────────────────


def fetch_rows(remote: bool) -> list[dict[str, Any]]:
    """Execute the D1 query via wrangler and return parsed rows."""
    cmd = [
        "npx", "wrangler", "d1", "execute", DB_NAME,
        "--json", "--command", QUERY,
    ]
    if remote:
        cmd.append("--remote")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"wrangler failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Failed to parse wrangler output as JSON", file=sys.stderr)
        sys.exit(1)

    results = output[0].get("results", []) if isinstance(output, list) else output.get("results", [])

    if not results:
        print("No rows returned from D1. Has anyone clicked Run yet?", file=sys.stderr)
        sys.exit(1)

    return results


def parse_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Group rows by simulation family, parse JSON parameters and timestamps."""
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        family = row["simulation_id"]
        try:
            params = json.loads(row["parameters_json"])
        except (json.JSONDecodeError, TypeError):
            continue

        ts = datetime.fromisoformat(row["created_at"])
        by_family[family].append({"ts": ts, "params": params})

    return dict(by_family)


# ── Plotting helpers ────────────────────────────────────────────────────────


def setup_figure(n_params: int, title: str) -> tuple[plt.Figure, list[plt.Axes]]:
    """Create a figure with one subplot per parameter in a horizontal row."""
    fig, axes = plt.subplots(1, n_params, figsize=(5 * n_params, 4.5))
    if n_params == 1:
        axes = [axes]
    fig.suptitle(title, fontsize=13, fontweight="bold")
    return fig, axes


def save_figure(fig: plt.Figure, out_dir: Path, name: str) -> None:
    """Save figure to disk and close it."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  saved {path}")


# ── a) Histogram plots ──────────────────────────────────────────────────────


def plot_histograms(
    by_family: dict[str, list[dict[str, Any]]],
    out_dir: Path,
) -> None:
    """One figure per simulation family with a histogram subplot per parameter."""
    print("\nGenerating histogram grids...")

    for family, entries in sorted(by_family.items()):
        if not entries:
            continue

        param_names = list(entries[0]["params"].keys())
        fig, axes = setup_figure(len(param_names), f"{FAMILY_LABELS.get(family, family)} — Parameter Distributions")
        color = FAMILY_COLORS.get(family, "#333333")

        for ax, pname in zip(axes, param_names):
            values = [e["params"].get(pname) for e in entries if pname in e["params"]]

            if not values:
                ax.text(0.5, 0.5, "no data", ha="center", va="center", transform=ax.transAxes)
                continue

            bins = min(30, max(5, len(values) // 3))
            ax.hist(values, bins=bins, color=color, edgecolor="white", linewidth=0.5, alpha=0.85)
            ax.set_title(pname, fontsize=10)
            ax.set_xlabel("value")
            ax.set_ylabel("count")

            mean = np.mean(values)
            ax.axvline(mean, color="#e74c3c", linestyle="--", linewidth=1, label=f"mean={mean:.3g}")
            ax.legend(fontsize=8)

        fig.tight_layout()
        save_figure(fig, out_dir, f"histogram_{family}.png")


# ── b) Time-series diagnostics ──────────────────────────────────────────────


def plot_time_series(
    by_family: dict[str, list[dict[str, Any]]],
    out_dir: Path,
) -> None:
    """Time-series plots showing parameter evolution and daily activity."""
    print("\nGenerating time-series diagnostics...")

    for family, entries in sorted(by_family.items()):
        if not entries:
            continue

        param_names = list(entries[0]["params"].keys())
        color = FAMILY_COLORS.get(family, "#333333")
        label = FAMILY_LABELS.get(family, family)

        # Sort by timestamp
        entries_sorted = sorted(entries, key=lambda e: e["ts"])
        timestamps = [e["ts"] for e in entries_sorted]

        if len(timestamps) < 2:
            print(f"  skipping {family} — needs at least 2 data points")
            continue

        # ── Parameter values over time (scatter + rolling mean) ──
        fig, axes = setup_figure(
            len(param_names),
            f"{label} — Parameter Values Over Time",
        )

        for ax, pname in zip(axes, param_names):
            values = np.array([e["params"].get(pname) for e in entries_sorted if pname in e["params"]])

            if len(values) < 2:
                ax.text(0.5, 0.5, "not enough data", ha="center", va="center", transform=ax.transAxes)
                continue

            t_vals = timestamps[:len(values)]

            ax.scatter(t_vals, values, s=12, color=color, alpha=0.5, edgecolors="none")

            # Rolling mean
            window = max(5, len(values) // 10)
            if len(values) >= window:
                rolling = np.convolve(values, np.ones(window) / window, mode="valid")
                ax.plot(t_vals[window - 1:], rolling, color="#e74c3c", linewidth=1.5, label=f"rolling mean (n={window})")

            ax.set_title(pname, fontsize=10)
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d\n%H:%M"))
            ax.legend(fontsize=7)

        fig.tight_layout()
        save_figure(fig, out_dir, f"timeseries_{family}.png")


def plot_runs_per_day(
    by_family: dict[str, list[dict[str, Any]]],
    out_dir: Path,
) -> None:
    """Single figure with one line per simulation family showing daily run counts."""
    print("\nGenerating runs per day...")

    fig, ax = plt.subplots(figsize=(12, 4))

    for family, entries in sorted(by_family.items()):
        color = FAMILY_COLORS.get(family, "#333333")
        label = FAMILY_LABELS.get(family, family)
        timestamps = [e["ts"] for e in entries]

        daily_counts: dict[str, int] = defaultdict(int)
        for ts in timestamps:
            daily_counts[ts.strftime("%Y-%m-%d")] += 1

        days = sorted(daily_counts.keys())
        counts = [daily_counts[d] for d in days]
        day_dates = [datetime.strptime(d, "%Y-%m-%d") for d in days]

        ax.plot(day_dates, counts, color=color, linewidth=2, marker="o",
                markersize=5, label=label)

    ax.set_title("Runs Per Day", fontsize=12, fontweight="bold")
    ax.set_ylabel("runs")
    ax.legend(fontsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    fig.tight_layout()
    save_figure(fig, out_dir, "runs_per_day.png")


def plot_overview(by_family: dict[str, list[dict[str, Any]]], out_dir: Path) -> None:
    """Single overview figure: total runs per family bar chart."""
    print("\nGenerating overview...")

    fig, ax = plt.subplots(figsize=(6, 3.5))
    families = sorted(by_family.keys(), key=lambda f: len(by_family[f]), reverse=True)
    counts = [len(by_family[f]) for f in families]
    colors = [FAMILY_COLORS.get(f, "#999999") for f in families]
    labels = [FAMILY_LABELS.get(f, f) for f in families]

    bars = ax.bar(range(len(families)), counts, color=colors, edgecolor="white", linewidth=0.5)
    for bar, count in zip(bars, counts):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                str(count), ha="center", fontsize=9, fontweight="bold")

    ax.set_xticks(range(len(families)))
    ax.set_xticklabels(labels)
    ax.set_title("Total Runs Per Simulation Family", fontsize=12, fontweight="bold")
    ax.set_ylabel("runs")
    fig.tight_layout()
    save_figure(fig, out_dir, "overview_runs_per_family.png")


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot parameter distribution diagnostics from D1")
    parser.add_argument("--remote", action="store_true",
                        help="Query the remote (production) D1 database rather than local")
    parser.add_argument("--out", type=Path, default=Path("plots"),
                        help="Output directory for generated figures (default: plots/)")
    args = parser.parse_args()

    print(f"Querying {'remote' if args.remote else 'local'} D1 database...")
    rows = fetch_rows(remote=args.remote)
    by_family = parse_rows(rows)

    print(f"Loaded {sum(len(v) for v in by_family.values())} rows across {len(by_family)} families: "
          f"{', '.join(f'{k} ({len(v)})' for k, v in sorted(by_family.items()))}")

    out_dir = args.out
    plot_overview(by_family, out_dir)
    plot_histograms(by_family, out_dir)
    plot_time_series(by_family, out_dir)
    plot_runs_per_day(by_family, out_dir)

    print(f"\nDone. Figures saved to {out_dir.resolve()}/")


if __name__ == "__main__":
    main()
