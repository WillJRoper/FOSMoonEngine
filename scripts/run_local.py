#!/usr/bin/env python3
"""One-command local launcher for UniverseEngine.

This script:
1. Ensures a local manifest exists, downloading assets first when needed.
2. Starts the local tracking server unless one is already running.
3. Launches the Vite dev server in the configured Vite mode.
"""

from __future__ import annotations

import argparse
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
LOCAL_MANIFEST = REPO_ROOT / "public" / "assets" / "local-manifest.json"
TRACKING_HOST = "127.0.0.1"
TRACKING_PORT = 8765


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh-assets",
        action="store_true",
        help="Re-download assets and regenerate the local manifest before launch.",
    )
    parser.add_argument(
        "--skip-setup",
        action="store_true",
        help="Skip asset download/manifest generation checks.",
    )
    parser.add_argument(
        "--mode",
        default="localmanifest",
        help="Vite mode to use (default: localmanifest).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.skip_setup:
        ensure_local_setup(force_refresh=args.refresh_assets)

    tracking_process = start_tracking_server_if_needed()

    def shutdown(_signum: int, _frame: object) -> None:
        terminate_process(tracking_process)
        raise SystemExit(130)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    vite = REPO_ROOT / "node_modules" / ".bin" / "vite"

    if not vite.is_file():
        raise SystemExit(f"Vite binary not found at {vite}. Run 'npm install' first.")

    try:
        subprocess.run([str(vite), "--mode", args.mode], cwd=REPO_ROOT, check=True)
    finally:
        terminate_process(tracking_process)


def ensure_local_setup(*, force_refresh: bool) -> None:
    if force_refresh or not LOCAL_MANIFEST.is_file():
        print("Preparing local assets and manifest...")
        run_checked(["python3", "scripts/download_engine_assets.py"])
        run_checked(["python3", "scripts/generate_run_manifest.py", "--local"])
        return

    print(f"Using existing local manifest: {LOCAL_MANIFEST}")


def start_tracking_server_if_needed() -> subprocess.Popen[str] | None:
    if is_port_open(TRACKING_HOST, TRACKING_PORT):
        print(f"Using existing tracking server on http://{TRACKING_HOST}:{TRACKING_PORT}")
        return None

    print("Starting local tracking server...")
    process = subprocess.Popen(
        [sys.executable, "scripts/local_tracking_server.py"],
        cwd=REPO_ROOT,
        text=True,
    )

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"Tracking server exited early with code {process.returncode}")
        if is_port_open(TRACKING_HOST, TRACKING_PORT):
            print(f"Tracking server ready on http://{TRACKING_HOST}:{TRACKING_PORT}")
            return process
        time.sleep(0.1)

    terminate_process(process)
    raise SystemExit("Tracking server did not become ready in time")


def is_port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((host, port)) == 0


def terminate_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_checked(command: list[str]) -> None:
    subprocess.run(command, cwd=REPO_ROOT, check=True)


if __name__ == "__main__":
    main()
