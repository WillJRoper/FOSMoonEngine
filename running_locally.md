# Running MoonEngine Locally

Everything you need to get the MoonEngine app running on your own machine with
local simulation assets.

## Prerequisites

| Tool | Minimum version | Why |
|---|---|---|
| **Node.js** | 18 | Vite 6 requires ESM support. Node 18 is the oldest supported LTS. |
| **npm** | (bundled with Node) | Package manager for the frontend. |
| **Python** | 3.9 | Asset-generation and server scripts. |
| **ffprobe** | (any modern build) | Video metadata probing. Part of `ffmpeg`. |

### Windows users

This project targets Unix-like environments. Windows users should use
**WSL 2** (Windows Subsystem for Linux) with an Ubuntu distribution.
All instructions below assume you are working inside WSL.

1. Install WSL: `wsl --install` from PowerShell or Command Prompt (admin).
2. Reboot, then launch **Ubuntu** from the Start menu.
3. Follow the **Ubuntu / Debian / WSL** install commands in each section below.
4. Keep the repository inside the WSL filesystem (`~/...`), **not** `/mnt/c/...` —
   filesystem performance and case sensitivity differ. |

### Installing prerequisites

**Node.js** — the simplest way is [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Restart your terminal, then:
nvm install 22
```

**Python** — macOS and most Linux distributions include Python 3 already.  Check
with `python3 --version`.  If you need to install it:

```bash
# macOS
brew install python3

# Ubuntu / Debian
sudo apt install python3

# WSL — same as Ubuntu
```

**ffprobe** — bundled with `ffmpeg`:

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian / WSL
sudo apt install ffmpeg
```

## Quick start

For the full local experience, start here:

```bash
npm install
npm run local
```

Open `http://localhost:5173`.

`npm run local` downloads assets and generates `public/assets/local-manifest.json`
if needed, starts local tracking, and launches the app in forced local-manifest
mode.

## Quick start (with cloud assets)

If you just want to browse the simulation runs that are already hosted online,
you only need two commands:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.  The app defaults to **online** manifest mode and
streams assets from the Cloudflare R2 bucket.

> **Note:** You won't be able to play videos offline this way, and planet-selection
> tracking won't be recorded unless you also run the local tracking server
> (see [Local Tracking](#local-tracking)).

## Full local setup (with offline assets)

The recommended command is still:

```bash
npm run local
```

This one command:

1. downloads assets and generates `public/assets/local-manifest.json` if needed
2. starts the local tracking server and creates `local_tracking.db` if needed
3. starts Vite in forced local-manifest mode

Use the lower-level commands below only if you want more control over individual steps.

## Manual local commands

### Clone and install

```bash
git clone <repo-url> && cd MoonEngine
npm install
```

### Prepare assets and manifest

One-step asset setup:

```bash
npm run setup:local
```

Or, if you want finer control:

```bash
npm run download:assets          # all three families
npm run download:cosmos          # cosmos only
npm run generate:run-manifest    # regenerate local manifest
```

This reads `public/assets/run-manifest.json` and downloads every referenced
video, CSV, and YAML file. Files that already exist locally are skipped.

### Start just the frontend in local-manifest mode

```bash
npm run dev:local
```

This forces the app to use `public/assets/local-manifest.json` on startup.

### Start just the tracking server

```bash
npm run tracking:server
```

This writes run selections to `local_tracking.db`.

### (Optional) Refresh run summaries

If CSV data or video files have changed and you need up-to-date
`run_summary.yaml` files for every run:

```bash
python3 scripts/generate_run_summaries.py
```

Requires `ffprobe`.

### Manual UI fallback

If you start with plain `npm run dev`, the app defaults to **online** manifest
mode unless you change it manually:

1. Start the dev server: `npm run dev`
2. Open Settings (burger menu → Settings)
3. Click the **Advanced Settings** toggle and enter the password: `RSSSE26UM_Engine`
4. Set **Manifest Source** to `local`

> **Tip:** You can verify the switch worked by checking the browser console
> for `Manifest source: local` messages.

## Local tracking

When you select a run and press "Let's Go", the app sends a tracking POST with
the chosen parameters.  In production this goes to a Cloudflare Worker that
writes to a D1 database.  We can replicate that locally.

`npm run local` starts this for you automatically.

If you are running the pieces manually, start the tracking server in a separate
terminal:

```bash
npm run tracking:server
```

This starts a small Python HTTP server on `http://127.0.0.1:8765` that receives
`POST /api/track-run` and writes each selection to `local_tracking.db`.

In dev mode, Vite proxies `/api/track-run` to this server automatically, so
your parameter selections are recorded without any manual configuration.

You can check how many records have been captured:

```bash
curl http://localhost:8765/api/track-run/count
```

### Sync local records to the cloud D1 database

After accumulating records locally, push them to the online D1 database:

```bash
npm run tracking:sync
```

This reads every row from `local_tracking.db`, inserts them into the remote
D1 `run_selections` table in batches, and deletes the synced records from the
local database.

Options:

```bash
npm run tracking:sync -- --dry-run   # preview without touching D1
npm run tracking:sync -- --no-clear  # upload but keep local records
```

## Troubleshooting

### `SyntaxError: Unexpected token {` on `npm run dev`

Your Node.js version is too old.  See [Prerequisites](#prerequisites) above.

### `qt.qpa.xcb: could not connect to display` on WSL

This is a system-level Qt library conflict in some WSL installations and is
**not related to this project**.  Make sure `node_modules` exists (`npm
install`).  If the error persists, check your `PATH` for any Qt-linked
binaries that may be shadowing `node` or `vite`.

### Empty / blank screen after starting

The app defaults to **online** manifest mode and may fall back to placeholder
assets if no network is available.  Switch to **local** mode in
Settings → Advanced Settings → Manifest Source.

### Missing videos or "4 views expected, only 3 shown"

Run `npm run generate:run-manifest` to regenerate the local manifest.  If you
added runs manually, make sure each run directory under `public/assets/`
contains the expected video files in `animations/`.
