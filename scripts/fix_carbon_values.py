#!/usr/bin/env python3
"""Recalculate carbonBurnt values in run_summary.yaml files.

Uses the CO₂ formula:
    kgCO₂ = 3.07e-3 * N_cores * wallclock_days

Which is equivalent to:
    carbonBurnt = computeUsed * 3.07e-3 / 24
                ≈ computeUsed * 0.000128

This replaces any existing carbonBurnt values derived from an incorrect
older formula used in the galaxy and cosmos families.

Usage:

    # Dry-run (report only)
    python3 scripts/fix_carbon_values.py --dry-run

    # Fix a single directory
    python3 scripts/fix_carbon_values.py public/assets/galaxy/track308

    # Fix everything under public/assets
    python3 scripts/fix_carbon_values.py
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO_ROOT / "public" / "assets"
CARBON_FACTOR = 3.07e-3 / 24.0  # kgCO₂ per CPU-hour
ROUNDING = 6
TOLERANCE = 1e-9
SKIP_NAMES = frozenset({".DS_Store", "__pycache__", ".ipynb_checkpoints"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=DEFAULT_ROOT,
        help="Directory to scan for run_summary.yaml files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    target = args.path.expanduser().resolve()
    summaries = discover_summaries(target)

    if not summaries:
        raise SystemExit(f"No run_summary.yaml files found under {target}")

    changed = 0
    skipped = 0
    errors = 0

    for summary_path in summaries:
        try:
            fixed = fix_one_summary(summary_path, dry_run=args.dry_run)
            if fixed is None:
                skipped += 1
            elif fixed:
                changed += 1
        except Exception as exc:
            print(f"  ERROR {summary_path.relative_to(REPO_ROOT)}: {exc}")
            errors += 1

    print()
    print(f"Done. {changed} fixed, {skipped} already correct, {errors} errors.")


def discover_summaries(target: Path) -> list[Path]:
    if target.is_file() and target.name == "run_summary.yaml":
        return [target]
    if target.is_dir():
        summaries: list[Path] = []
        for path in target.rglob("run_summary.yaml"):
            if any(
                part in SKIP_NAMES or part.startswith(".") for part in path.parts
            ):
                continue
            summaries.append(path)
        return sorted(summaries)
    raise SystemExit(f"Not a directory or run_summary.yaml: {target}")


def fix_one_summary(path: Path, *, dry_run: bool) -> bool | None:
    text = path.read_text(encoding="utf-8")

    carbon_line = find_yaml_key(text, "carbonBurnt")
    compute_line = find_yaml_key(text, "computeUsed")

    if carbon_line is None or compute_line is None:
        return None

    compute_used = parse_yaml_value(compute_line)
    if compute_used is None:
        return None

    new_carbon = round(compute_used * CARBON_FACTOR, ROUNDING)
    old_carbon = parse_yaml_value(carbon_line)

    if old_carbon is not None and abs(old_carbon - new_carbon) < TOLERANCE:
        return False

    new_text = replace_yaml_value(text, "carbonBurnt", format_value(new_carbon))
    rel = path.relative_to(REPO_ROOT)

    if dry_run:
        print(f"  [DRY-RUN] would fix {rel}  {old_carbon}  →  {new_carbon}")
    else:
        path.write_text(new_text, encoding="utf-8")
        print(f"  fixed {rel}  {old_carbon}  →  {new_carbon}")

    return True


def find_yaml_key(text: str, key: str) -> str | None:
    pattern = rf"^{key}\s*:\s*(.+)"
    for line in text.splitlines():
        match = re.match(pattern, line)
        if match:
            return match.group(1).strip()
    return None


def parse_yaml_value(raw: str) -> float | None:
    try:
        cleaned = re.sub(r"#.*$", "", raw).strip()
        return float(cleaned)
    except (ValueError, TypeError):
        return None


def replace_yaml_value(text: str, key: str, new_value: str) -> str:
    pattern = rf"^({key}\s*:\s*)(.+)"
    replacement = rf"\g<1>{new_value}"
    return re.sub(pattern, replacement, text, count=1, flags=re.MULTILINE)


def format_value(value: float) -> str:
    formatted = f"{value:.{ROUNDING}f}"
    return formatted.rstrip("0").rstrip(".") if "." in formatted else formatted


if __name__ == "__main__":
    main()
