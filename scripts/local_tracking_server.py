#!/usr/bin/env python3
"""Local tracking server — receives run-selection POSTs and stores them in SQLite.

Start this alongside ``npm run dev`` to capture parameter selections while
working locally.  The server listens on ``http://localhost:8765`` and Vite
proxies ``/api/track-run`` to it in dev mode.

Schema mirrors the Cloudflare D1 ``run_selections`` table.

Usage::

    python3 scripts/local_tracking_server.py
    python3 scripts/local_tracking_server.py --port 8765 --db local_tracking.db
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "local_tracking.db"
DEFAULT_PORT = 8765
TABLE_SQL = """\
CREATE TABLE IF NOT EXISTS run_selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    simulation_id TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    manifest_source TEXT NOT NULL,
    matched_run_id TEXT,
    asset_host_mode TEXT,
    asset_host_base TEXT
);
"""

VALID_SIMULATION_IDS = frozenset({"planetary", "galaxy", "cosmos"})
VALID_MANIFEST_SOURCES = frozenset({"local", "online"})
VALID_ASSET_HOST_MODES = frozenset({"local", "primary", "backup"})
MAX_PARAMETER_COUNT = 16


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to listen on (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to local SQLite database (default: {DEFAULT_DB})",
    )
    return parser.parse_args()


def validate_payload(body: dict[str, Any]) -> str | None:
    """Return an error message string if the payload is invalid."""
    simulation_id = body.get("simulationId")
    if not isinstance(simulation_id, str) or simulation_id not in VALID_SIMULATION_IDS:
        return "Invalid simulationId"

    params = body.get("parameters")
    if not isinstance(params, dict) or len(params) > MAX_PARAMETER_COUNT:
        return "Invalid parameters"

    for value in params.values():
        if not isinstance(value, (int, float)) or not _is_finite(value):
            return "Parameter values must be finite numbers"

    manifest_source = body.get("manifestSource")
    if not isinstance(manifest_source, str) or manifest_source not in VALID_MANIFEST_SOURCES:
        return "Invalid manifestSource"

    matched_run_id = body.get("matchedRunId")
    if matched_run_id is not None and not isinstance(matched_run_id, str):
        return "matchedRunId must be a string or absent"

    asset_host_mode = body.get("assetHostMode")
    if not isinstance(asset_host_mode, str) or asset_host_mode not in VALID_ASSET_HOST_MODES:
        return "Invalid assetHostMode"

    asset_host_base = body.get("assetHostBase")
    if asset_host_base is not None and not isinstance(asset_host_base, str):
        return "assetHostBase must be a string or null"

    return None


def _is_finite(value: float) -> bool:
    return value == value and value != float("inf") and value != float("-inf")


def init_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute(TABLE_SQL)
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(run_selections)").fetchall()
    }
    if "asset_host_mode" not in columns:
        conn.execute("ALTER TABLE run_selections ADD COLUMN asset_host_mode TEXT")
    if "asset_host_base" not in columns:
        conn.execute("ALTER TABLE run_selections ADD COLUMN asset_host_base TEXT")
    conn.execute(
        """
        UPDATE run_selections
        SET
          asset_host_mode = CASE manifest_source
            WHEN 'local' THEN 'local'
            ELSE 'primary'
          END,
          asset_host_base = CASE manifest_source
            WHEN 'local' THEN NULL
            ELSE 'https://media.universemakers.org'
          END
        WHERE asset_host_mode IS NULL OR asset_host_base IS NULL
        """
    )
    conn.commit()
    return conn


def insert_run(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO run_selections (created_at, simulation_id, parameters_json, manifest_source, matched_run_id, asset_host_mode, asset_host_base) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            datetime.now(timezone.utc).isoformat(),
            payload["simulationId"],
            json.dumps(payload["parameters"]),
            payload["manifestSource"],
            payload.get("matchedRunId"),
            payload["assetHostMode"],
            payload.get("assetHostBase"),
        ),
    )
    conn.commit()


class TrackingHandler(BaseHTTPRequestHandler):
    conn: sqlite3.Connection

    def do_POST(self) -> None:
        if self.path != "/api/track-run":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self.send_error(400, "Empty body")
            return

        raw = self.rfile.read(content_length)

        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        if not isinstance(body, dict):
            self.send_error(400, "Payload must be a JSON object")
            return

        error = validate_payload(body)
        if error:
            self.send_error(400, error)
            return

        try:
            insert_run(self.conn, body)
            print(f"  {body['simulationId']:12s}  {json.dumps(body['parameters'])}")
        except sqlite3.Error as exc:
            self.send_error(500, f"Database error: {exc}")
            return

        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/track-run/count":
            cursor = self.conn.execute("SELECT COUNT(*) FROM run_selections")
            count = cursor.fetchone()[0]
            payload = json.dumps({"count": count}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_error(404)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # suppress default stderr logging; we print our own


def main() -> None:
    args = parse_args()
    db_path = args.db.expanduser().resolve()

    conn = init_db(db_path)
    print(f"Local tracking database: {db_path}")

    server = HTTPServer(("127.0.0.1", args.port), TrackingHandler)

    def shutdown(signum: int, _frame: Any) -> None:
        print("\nShutting down...")
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"Listening on http://127.0.0.1:{args.port}/api/track-run")
    print("Press Ctrl+C to stop.\n")

    # Attach the DB connection to the handler class so every request shares it.
    TrackingHandler.conn = conn

    try:
        server.serve_forever()
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
