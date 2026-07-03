#!/usr/bin/env python3
"""Sync local tracking records to the Cloudflare D1 database, then clear them.

Reads every row from the local SQLite database created by
``scripts/local_tracking_server.py``, inserts them into the remote D1
``run_selections`` table using ``wrangler d1 execute --remote``, and
deletes them from the local database once the upload is confirmed.

Usage::

    python3 scripts/sync_tracking_to_d1.py
    python3 scripts/sync_tracking_to_d1.py --db local_tracking.db --dry-run
    python3 scripts/sync_tracking_to_d1.py --db local_tracking.db --no-clear
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "local_tracking.db"
DB_NAME = "universe-engine-db"
BATCH_SIZE = 50


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to local SQLite database (default: {DEFAULT_DB})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be synced without touching D1",
    )
    parser.add_argument(
        "--no-clear",
        action="store_true",
        help="Do not delete local records after syncing",
    )
    return parser.parse_args()


def run_wrangler(sql: str, dry_run: bool) -> bool:
    """Execute a SQL statement against the remote D1 database."""
    if dry_run:
        print(f"    [DRY-RUN] {sql[:120]}{'...' if len(sql) > 120 else ''}")
        return True

    result = subprocess.run(
        [
            "npx", "wrangler", "d1", "execute", DB_NAME,
            "--remote", "--command", sql,
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        print(f"    ERROR: {result.stderr.strip()}", file=sys.stderr)
        return False
    return True


def _hash_record(row: tuple) -> str:
    """Hash a record for progress display."""
    raw = json.dumps(row, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:8]


def main() -> None:
    args = parse_args()
    db_path = args.db.expanduser().resolve()

    if not db_path.is_file():
        print(f"No local tracking database found at {db_path}. Nothing to sync.")
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, created_at, simulation_id, parameters_json, manifest_source, matched_run_id, asset_host_mode, asset_host_base "
        "FROM run_selections ORDER BY id ASC"
    ).fetchall()

    if not rows:
        print("Local tracking database is empty. Nothing to sync.")
        conn.close()
        return

    print(f"Found {len(rows)} local record(s) to sync.\n")

    if args.dry_run:
        print("DRY-RUN MODE — D1 will not be modified\n")

    synced_ids: list[int] = []
    batch: list[str] = []

    for i, row in enumerate(rows, 1):
        matched = f"'{row['matched_run_id']}'" if row["matched_run_id"] else "NULL"
        asset_host_mode = f"'{row['asset_host_mode']}'" if row["asset_host_mode"] else "NULL"
        asset_host_base = f"'{row['asset_host_base']}'" if row["asset_host_base"] else "NULL"
        insert_sql = (
            f"INSERT INTO run_selections "
            f"(created_at, simulation_id, parameters_json, manifest_source, matched_run_id, asset_host_mode, asset_host_base) "
            f"VALUES ('{row['created_at']}', '{row['simulation_id']}', "
            f"'{row['parameters_json']}', '{row['manifest_source']}', {matched}, {asset_host_mode}, {asset_host_base})"
        )
        batch.append(insert_sql)
        synced_ids.append(row["id"])

        if len(batch) >= BATCH_SIZE or i == len(rows):
            sql = ";\n".join(batch) + ";"
            label = f"Batch {i - len(batch) + 1}–{i} ({len(batch)} records)"
            print(f"  {label}")
            if run_wrangler(sql, args.dry_run):
                if not args.no_clear and not args.dry_run:
                    for rid in synced_ids[-len(batch):]:
                        conn.execute("DELETE FROM run_selections WHERE id = ?", (rid,))
                    conn.commit()
            else:
                print(f"  Sync failed at batch starting record {synced_ids[-len(batch)]}. "
                      "Local records preserved.", file=sys.stderr)
                conn.close()
                sys.exit(1)
            batch = []

    if not args.dry_run and not args.no_clear:
        remaining = conn.execute("SELECT COUNT(*) FROM run_selections").fetchone()[0]
        print(f"\n  Cleared synced records. {remaining} record(s) remain locally.")
    elif args.no_clear:
        print(f"\n  Sync complete. {len(synced_ids)} record(s) kept locally (--no-clear).")
    else:
        print(f"\n  [DRY-RUN] {len(synced_ids)} record(s) would be synced and cleared.")

    conn.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
