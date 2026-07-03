# MoonEngine

A web app for displaying and interacting with simulation videos spread across a parameter hypercube.

## Quick Start

For the full local experience:

```bash
npm install
npm run local
```

Open `http://localhost:5173`.

For cloud-only browsing without local assets or local tracking:

```bash
npm install
npm run dev
```

Open `http://localhost:5173` — the app streams assets from the cloud by default.

For a full offline setup, asset downloads, local tracking, and production
workflows, see **[Running Locally](./running_locally.md)**.

## Requirements

- **Node.js >= 18** (Vite 6 requires ESM support; Node 18 is the minimum supported LTS)
- **Python >= 3.9** for asset-generation scripts
- **ffprobe** (part of `ffmpeg`) for `scripts/generate_run_summaries.py`

## Quick Reference

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run local` | One-command local launcher |
| `npm run dev` | Start dev server |
| `npm run dev:local` | Start dev server forced to local manifest mode |
| `npm run setup:local` | Download assets and generate local manifest |
| `npm run generate:run-manifest` | Regenerate `public/assets/local-manifest.json` |
| `npm run build` | Production build |
| `npm run format` | Format source files |
| `npm run format:check` | Check formatting (CI) |
| `python3 scripts/generate_run_summaries.py` | Refresh per-run `run_summary.yaml` files |
| `npm run download:assets` | Download all cloud assets to `public/assets/` |
| `npm run download:cosmos` | Download cosmos cloud assets only |
| `npm run tracking:server` | Start local tracking server |
| `npm run tracking:sync` | Sync local tracking DB to online D1 |

## App Configuration

The app now has a password-gated `Advanced Settings` section inside the normal `Settings` overlay.

Advanced settings include:

- locking the app to a single cosmic scale
- choosing manifest source: `local` or `online`
- toggling verbose console logging
- hiding selected scales from the landing screen

Current default behavior:

- the app defaults to `online` manifest mode
- online manifest mode fetches the bucket-hosted `run-manifest.json` from the fixed URL in `src/shared/constants.ts`
- `local` manifest mode is still available in Advanced Settings as an explicit fallback override
- `npm run dev:local` forces local manifest mode regardless of previously saved browser settings

## Current UI Structure

The app currently uses a four-mode interface:

- `entry` - first-load simulation-family chooser
- `config` - overlay for parameter tuning and theme settings
- `initializing` - terminal-style faux startup window shown after run
- `display` - viewport with telemetry panel, timeline, and a burger menu that opens `Home`, `Settings`, `Credits`, and `Fullscreen`

Inside `Settings`, the `Advanced Settings` section is password-gated for exhibit / kiosk style controls.

See `UI_ARCHITECTURE.md` for the current component and state breakdown.

## Repository Layout

- `src/main.ts` - browser entrypoint (imports global CSS, boots the app)
- `src/app/` - app shell/orchestration
- `src/entry/` - landing screen / scale selection overlay
- `src/loading/` - initialization overlay and boot text
- `src/live-data/` - CSV parsing, HUD sampling, telemetry presentation
- `src/selection/` - parameter editor, settings overlay, theme picker, manifest-backed asset lookup
- `src/shared/` - cross-cutting helpers like URLs, logging, and advanced settings persistence
- `src/summaries/` - run summary overlay and metrics
- `src/video_player/` - viewport, view switcher, and timeline
- `scripts/` - manifest, summary, and upload utilities
- `public/assets/` - local runtime assets and generated manifests

## Asset Layout

Simulation assets live under `public/assets/` using a run-based layout:

- `public/assets/<simulation-id>/<run-id>/animations/*.mp4`
- `public/assets/<simulation-id>/<run-id>/live_data_table.csv`
- `public/assets/<simulation-id>/<run-id>/final_snapshot_summary.csv`
- `public/assets/<simulation-id>/<run-id>/run_summary.yaml`

The frontend resolves the nearest available run through a generated manifest.

Current manifest files:

- `public/assets/local-manifest.json` - default local manifest used by the app
- `public/assets/run-manifest.json` - optional online manifest intended for Cloudflare-hosted assets

## Manifest And Summary Generation

### 1. Refresh run summaries

Run this when `final_snapshot_summary.csv`, `live_data_table.csv`, or the videos have changed:

```bash
python3 scripts/generate_run_summaries.py
```

This writes one `run_summary.yaml` file per run directory.

Note: this script requires `ffprobe` to be available on your machine.

### 2. Refresh the local manifest

This is the default manifest used by the app today:

```bash
npm run generate:run-manifest
```

Equivalent explicit form:

```bash
python3 scripts/generate_run_manifest.py --local --output "public/assets/local-manifest.json"
```

This writes:

- `public/assets/local-manifest.json`

### Local Setup Shortcut

To prepare local assets if needed, start local tracking, and launch the app in
local-manifest mode with one command:

```bash
npm run local
```

Lower-level helpers remain available when you want more control:

```bash
npm run setup:local
npm run dev:local
npm run tracking:server
```

### 3. Refresh the online manifest

The online manifest is generated from the actual R2 bucket contents under the
fixed `engine/` prefix.

Set these environment variables first:

```bash
export R2_BUCKET="YOUR_BUCKET"
export R2_PUBLIC_BASE="https://YOUR_PUBLIC_R2_BASE"
export R2_BACKUP_BASE="https://YOUR_BACKUP_R2_BASE"
export R2_ACCOUNT_ID="YOUR_ACCOUNT_ID"
export R2_ACCESS_KEY_ID="YOUR_ACCESS_KEY_ID"
export R2_SECRET_ACCESS_KEY="YOUR_SECRET_ACCESS_KEY"
```

Then generate the online manifest:

```bash
python3 scripts/generate_run_manifest.py
```

This writes:

- `public/assets/run-manifest.json`

The generator:

- scans the actual bucket contents below `engine/`
- groups objects into simulation runs
- fetches `parameters.yaml` when present
- writes the frontend manifest based on what is actually online

### Recommended local workflow

If you have changed local assets, run:

```bash
python3 scripts/generate_run_summaries.py
npm run generate:run-manifest
```

### Recommended online workflow

If you are preparing a Cloudflare-backed manifest, run:

```bash
python3 scripts/generate_run_summaries.py
python3 scripts/generate_run_manifest.py
```

### Upload workflow

Manifest generation is intentionally separate from the upload step.

1. Generate `public/assets/run-manifest.json` locally.
2. Upload the assets tree to R2.
3. Upload the already-generated manifest as a final publishing step.

Example:

```bash
python3 scripts/generate_run_manifest.py
python3 scripts/upload_engine_assets_to_r2.py --assets-dir public/assets --manifest-path public/assets/run-manifest.json
```

Or, if you only need to publish the manifest after regenerating it:

```bash
python3 scripts/upload_run_manifest_to_r2.py
```

The manifest generator:

- scans `public/assets/planetary/`, `public/assets/galaxy/`, and `public/assets/cosmos/`
- reads `parameters.yaml` when present
- falls back to supported parameter tokens in the run directory name when needed
- writes either a local or online manifest depending on flags

Current supported cosmos run-name tokens are:

- `Fb` -> `baryon_fraction`
- `Ef` -> `black_hole_strength`
- `G` -> `gravity_strength`

The manifest keeps local relative asset paths today, but the same schema can later be regenerated as `run-manifest.json` with remote URLs for Cloudflare-hosted assets.

## Testing Summary Overlays

A standalone test page for the end-of-run summary overlay lives at
`tests/summary-test.html`. It renders the summary screen exactly as the
app does — same CSS, same layout, same data pipeline — without requiring
a full video playback session.

### What it includes

- Dropdown to switch between simulation families (Planetary, Galaxy, Cosmos)
- Visual theme picker (Glass, Matrix, HAL 9000, Nostromo, Tron)
- Paired range slider + number input for every parameter in the selected family
- Configurable video duration (affects runtime formatting)
- Placeholder final-frame image (the hero panel is intentionally not the
  numeric score gauge — that path only triggers when no thumbnail is
  available, which never happens in the app)

### Running it

```bash
npm run dev
```

Then open `http://localhost:5173/tests/summary-test.html`.

The control panel floats top-right so you can tweak parameters and
re-show the overlay without reloading.

### What it's good for

- Visually verifying summary layout, card grids, result bars, and modal
  detail pop-ups across all simulation families and visual themes
- Catching regressions when YAML configs (parameter ranges, stat config,
  target messages) are updated
- Checking that per-family scoring behaviour (bar score vs. similarity
  fallback) produces the expected hero verdict and colour

## Notes

- If `Advanced Settings` is set to `online` before the online manifest exists, the app will fall back gracefully to placeholder assets.
- Verbose logging can be enabled in `Advanced Settings` for parameter-selection and manifest/debug output.
