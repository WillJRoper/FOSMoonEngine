/**
 * Standalone test page for the end-of-run summary overlay.
 *
 * Mirrors the app workflow exactly: manifest-backed nearest-neighbour
 * lookup → run-summary YAML load → overlay.render.  A canvas-drawn
 * placeholder stands in for the missing final video frame.
 *
 * Usage: open /tests/summary-test.html during `npm run dev`.
 */

import '../src/style.css';
import {
  createSummaryOverlay,
  type SummaryOverlayController,
} from '../src/summaries/summary-overlay.ts';
import {
  SIMULATION_CLASSES,
  type SimulationClass,
} from '../src/selection/simulation-catalog.ts';
import {
  applyTheme,
  THEMES,
} from '../src/selection/theme.ts';
import {
  loadVideoRunMetadata,
  type VideoRunMetadata,
} from '../src/selection/video-run-metadata.ts';
import {
  createManifestController,
  type ManifestController,
  type VideoMatch,
} from '../src/selection/placeholder-assets.ts';
import type { ManifestSource } from '../src/shared/advanced-settings.ts';

/* ── State ────────────────────────────────────────────────────────────── */

const app = document.getElementById('app')!;
const controls = document.getElementById('test-controls')!;

let activeClass = SIMULATION_CLASSES[0];
let values = makeDefaults(activeClass);
let controlsVisible = true;
let manifestSource: ManifestSource = 'local';
let manifestController: ManifestController = createManifestController('local');
let lastMatch: VideoMatch | null = null;
let metadataStatusEl: HTMLElement | null = null;

const PLACEHOLDER_DURATION_SECONDS = 120;

function makeDefaults(simClass: SimulationClass): Record<string, number> {
  return Object.fromEntries(
    simClass.parameters.map((p) => [p.id, p.fallbackValue]),
  );
}

/* ── Overlay ──────────────────────────────────────────────────────────── */

let overlay: SummaryOverlayController;

function mountOverlay(): void {
  overlay = createSummaryOverlay(app, {
    onReplay: () => overlay.hide(),
    onParameters: () => overlay.hide(),
    onHome: () => overlay.hide(),
    showHome: true,
  });
}

/* ── Toggle button ────────────────────────────────────────────────────── */

let toggleBtn: HTMLButtonElement;

function createToggleButton(): void {
  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = '\u25BC'; // ▼
  toggleBtn.style.cssText =
    'position:fixed;top:10px;right:10px;z-index:99999;' +
    'width:28px;height:28px;padding:0;border:1px solid rgba(99,196,232,0.25);' +
    'border-radius:3px;background:rgba(5,8,16,0.92);color:rgba(99,196,232,0.7);' +
    'font-size:14px;line-height:26px;text-align:center;cursor:pointer;';
  toggleBtn.addEventListener('click', () => {
    controlsVisible = !controlsVisible;
    controls.style.display = controlsVisible ? 'block' : 'none';
    toggleBtn.textContent = controlsVisible ? '\u25BC' : '\u25B2'; // ▼ or ▲
  });
  document.body.appendChild(toggleBtn);
}

/* ── Controls UI ──────────────────────────────────────────────────────── */

function buildControls(): void {
  controls.innerHTML = '';
  controls.style.cssText =
    'position:fixed;top:44px;right:10px;z-index:9999;' +
    'display:block;' +
    'background:rgba(5,8,16,0.95);border:1px solid rgba(99,196,232,0.25);' +
    'border-radius:4px;padding:16px;max-width:340px;max-height:88vh;' +
    'overflow-y:auto;font-family:monospace;color:#c8d6e5;font-size:13px;' +
    'line-height:1.5;backdrop-filter:blur(12px);';

  const title = document.createElement('div');
  title.style.cssText =
    'font-size:14px;font-weight:700;margin-bottom:12px;' +
    'color:#fff;border-bottom:1px solid rgba(99,196,232,0.2);padding-bottom:6px;';
  title.textContent = 'Summary Overlay Tester';
  controls.appendChild(title);

  /* ── Scale selector ──────────────────────────────────────────────── */
  const scaleGroup = labelledGroup('Simulation Family');

  const scaleSelect = document.createElement('select');
  scaleSelect.style.cssText =
    'width:100%;background:#0d1118;color:#c8d6e5;border:1px solid rgba(99,196,232,0.2);' +
    'padding:4px 8px;border-radius:3px;font:inherit;cursor:pointer;';

  for (const simClass of SIMULATION_CLASSES) {
    const option = document.createElement('option');
    option.value = simClass.id;
    option.textContent = simClass.label;
    if (simClass.id === activeClass.id) option.selected = true;
    scaleSelect.appendChild(option);
  }

  scaleSelect.addEventListener('change', () => {
    const next = SIMULATION_CLASSES.find((s) => s.id === scaleSelect.value);
    if (next) {
      activeClass = next;
      values = makeDefaults(activeClass);
      buildControls();
    }
  });

  scaleGroup.appendChild(scaleSelect);
  controls.appendChild(scaleGroup);

  /* ── Visual theme ────────────────────────────────────────────────── */
  const themeGroup = labelledGroup('Visual Theme');
  const themeRow = document.createElement('div');
  themeRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';

  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = theme.label;
    btn.style.cssText =
      'padding:2px 8px;border:1px solid rgba(99,196,232,0.2);border-radius:3px;' +
      'background:rgba(255,255,255,0.04);color:#aaa;cursor:pointer;font:inherit;font-size:11px;';
    btn.addEventListener('click', () => {
      applyTheme(theme.id);
      for (const b of themeRow.querySelectorAll('button')) {
        (b as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
        (b as HTMLButtonElement).style.color = '#aaa';
        (b as HTMLButtonElement).style.borderColor = 'rgba(99,196,232,0.2)';
      }
      btn.style.background = 'rgba(99,196,232,0.15)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'rgba(99,196,232,0.5)';
    });
    if (theme.id === 'glass') {
      btn.style.background = 'rgba(99,196,232,0.15)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'rgba(99,196,232,0.5)';
    }
    themeRow.appendChild(btn);
  }

  themeGroup.appendChild(themeRow);
  controls.appendChild(themeGroup);

  /* ── Parameters ──────────────────────────────────────────────────── */
  const paramGroup = labelledGroup('Parameters');

  for (const param of activeClass.parameters) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px;';

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;color:#8899aa;margin-bottom:2px;';
    label.textContent = `${param.label}${param.unit ? ` (${param.unit})` : ''}`;
    row.appendChild(label);

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(param.min);
    range.max = String(param.max);
    range.step = String(param.step);
    range.value = String(values[param.id] ?? param.fallbackValue);
    range.style.cssText = 'flex:1;accent-color:#63c4e8;';

    const number = document.createElement('input');
    number.type = 'number';
    number.min = String(param.min);
    number.max = String(param.max);
    number.step = String(param.step);
    number.value = String(values[param.id] ?? param.fallbackValue);
    number.style.cssText =
      'width:80px;background:#0d1118;color:#c8d6e5;border:1px solid rgba(99,196,232,0.2);' +
      'padding:2px 4px;border-radius:3px;font:inherit;font-size:12px;text-align:right;';

    range.addEventListener('input', () => {
      number.value = range.value;
      values[param.id] = Number(range.value);
    });

    number.addEventListener('change', () => {
      const v = Number(number.value);
      if (Number.isFinite(v)) {
        values[param.id] = v;
        range.value = String(v);
      }
    });

    inputRow.appendChild(range);
    inputRow.appendChild(number);
    row.appendChild(inputRow);
    paramGroup.appendChild(row);
  }

  controls.appendChild(paramGroup);

  /* ── Manifest source ─────────────────────────────────────────────── */
  const sourceGroup = labelledGroup('Manifest Source');

  const sourceRow = document.createElement('div');
  sourceRow.style.cssText = 'display:flex;gap:4px;';

  for (const src of ['local', 'online'] as ManifestSource[]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = src;
    btn.style.cssText =
      'flex:1;padding:4px 8px;border:1px solid rgba(99,196,232,0.2);border-radius:3px;' +
      'background:rgba(255,255,255,0.04);color:#aaa;cursor:pointer;font:inherit;font-size:11px;';
    if (src === manifestSource) {
      btn.style.background = 'rgba(99,196,232,0.15)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'rgba(99,196,232,0.5)';
    }
    btn.addEventListener('click', () => {
      manifestSource = src;
      manifestController = createManifestController(src);
      buildControls();
    });
    sourceRow.appendChild(btn);
  }

  sourceGroup.appendChild(sourceRow);
  controls.appendChild(sourceGroup);

  /* ── Last match info ─────────────────────────────────────────────── */
  metadataStatusEl = document.createElement('div');
  metadataStatusEl.style.cssText =
    'font-size:11px;margin-top:8px;min-height:15px;';
  if (lastMatch) {
    metadataStatusEl.textContent = `Matched run: ${lastMatch.runId ?? 'fallback'}`;
    metadataStatusEl.style.color = '#4CD98A';
  }
  controls.appendChild(metadataStatusEl);

  /* ── Buttons ─────────────────────────────────────────────────────── */
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.textContent = 'Show Summary';
  showBtn.style.cssText =
    'flex:1;padding:8px 16px;border:none;border-radius:3px;' +
    'background:rgba(99,196,232,0.2);color:#fff;cursor:pointer;font:inherit;' +
    'font-weight:600;font-size:13px;transition:background 0.2s;';
  showBtn.addEventListener('mouseenter', () => {
    showBtn.style.background = 'rgba(99,196,232,0.35)';
  });
  showBtn.addEventListener('mouseleave', () => {
    showBtn.style.background = 'rgba(99,196,232,0.2)';
  });
  showBtn.addEventListener('click', async () => {
    showBtn.disabled = true;
    showBtn.textContent = 'Loading...';

    if (metadataStatusEl) {
      metadataStatusEl.textContent = 'Searching manifest...';
      metadataStatusEl.style.color = '#E8951C';
    }

    const match = await manifestController.findNearestVideo(
      activeClass.id,
      activeClass.parameters,
      { ...values },
    );

    lastMatch = match;

    let metadata: VideoRunMetadata | null = null;

    if (metadataStatusEl) {
      metadataStatusEl.textContent = 'Loading metadata...';
    }

    if (match.summaryUrl) {
      try {
        metadata = await loadVideoRunMetadata(match.summaryUrl);
      } catch {
        metadata = null;
      }
    }

    if (metadataStatusEl) {
      const label = match.runId ?? 'fallback';
      metadataStatusEl.textContent = metadata
        ? `Matched run: ${label}`
        : `Matched run: ${label} (no metadata)`;
      metadataStatusEl.style.color = metadata ? '#4CD98A' : '#E8951C';
    }

    overlay.update(
      activeClass,
      { ...values },
      PLACEHOLDER_DURATION_SECONDS,
      metadata,
      makePlaceholderThumbnail(),
    );
    overlay.show();

    showBtn.disabled = false;
    showBtn.textContent = 'Show Summary';
  });

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.textContent = 'Hide';
  hideBtn.style.cssText =
    'padding:8px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;' +
    'background:rgba(255,255,255,0.05);color:#aaa;cursor:pointer;font:inherit;font-size:13px;';
  hideBtn.addEventListener('click', () => overlay.hide());

  btnRow.appendChild(showBtn);
  btnRow.appendChild(hideBtn);
  controls.appendChild(btnRow);
}

function labelledGroup(label: string): HTMLElement {
  const group = document.createElement('div');
  group.style.cssText = 'margin-bottom:12px;';

  const heading = document.createElement('div');
  heading.style.cssText =
    'font-size:11px;text-transform:uppercase;letter-spacing:0.5px;' +
    'color:rgba(99,196,232,0.7);margin-bottom:4px;';
  heading.textContent = label;
  group.appendChild(heading);

  return group;
}

/** Generate a dark placeholder frame that stands in for the missing video. */
function makePlaceholderThumbnail(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#070b12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(99,196,232,0.15)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.font = '18px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PLACEHOLDER  ·  Final Frame', canvas.width / 2, canvas.height / 2);

  return canvas.toDataURL('image/png');
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

applyTheme('glass');
mountOverlay();
createToggleButton();
buildControls();
