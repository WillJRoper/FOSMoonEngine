/**
 * Loading overlay (faux terminal boot sequence).
 *
 * This overlay is shown immediately after pressing Run. It prints a sequence of
 * terminal-like lines over time, then calls `onComplete` so the app can reveal
 * the viewport and transition to display mode.
 */

import type { InitializationLine } from './init-text.ts';
import { INITIALIZATION } from '../shared/constants.ts';

/** Terminal-style loading overlay shown between config and display mode.
 *
 * The overlay randomly picks and types lines from a pool. It stays visible for
 * at least its configured minimum duration and, if a `ready` promise is supplied,
 * continues printing random lines until that promise resolves. This lets the
 * app hide video downloads behind the terminal without risking a "frozen"
 * screen when the network is slow. */
export interface LoadingOverlayController {
  /** Start streaming terminal lines and call `onComplete` when the overlay
   *  has been shown for long enough AND `ready` (if supplied) has resolved. */
  show: (
    lines: InitializationLine[],
    onComplete: () => void,
    ready?: Promise<void>,
    options?: { minTerminalTimeMs?: number },
  ) => void;
  /** Immediately hide the overlay and clear any queued timers. */
  hide: () => void;
}

/**
 * Create and mount the loading overlay.
 *
 * @param container - Overlay layer host element.
 * @returns Controller for showing/hiding the boot sequence.
 */
export function createLoadingOverlay(container: HTMLElement): LoadingOverlayController {
  const { TYPING_MS_PER_CHAR, MIN_TERMINAL_TIME_MS, FINAL_PAUSE_MS } = INITIALIZATION;

  // Full-screen shell that blocks interaction while the faux boot sequence is
  // printing. CSS handles the visual treatment; this module handles sequencing.
  const overlay = document.createElement('section');

  overlay.className = 'overlay overlay--initializing';
  overlay.hidden = true;
  overlay.classList.add('is-hidden');

  // Everything inside the loading overlay is framed like a terminal window so
  // the user gets a clear transition from parameter selection into "simulation
  // startup" even though we are really just pacing text lines.
  const terminal = document.createElement('div');

  terminal.className = 'terminal';

  const header = document.createElement('div');

  header.className = 'terminal__header';
  header.innerHTML = `
    <div class="terminal__header-left">
      <span class="terminal__dot"></span>
      <span class="terminal__header-label">UNIVERSE_ENGINE_v9.5.1</span>
    </div>
  `;

  const log = document.createElement('div');

  log.className = 'terminal__log';

  terminal.appendChild(header);
  terminal.appendChild(log);
  overlay.appendChild(terminal);
  container.appendChild(overlay);

  let timers: number[] = [];
  let sequenceToken = 0;

  function clearTimers() {
    for (const timer of timers) {
      window.clearTimeout(timer);
    }

    timers = [];
  }

  function wait(ms: number, token: number): Promise<void> {
    // Every wait is token-aware so a new `show()` or `hide()` call can cancel an
    // in-flight sequence without us needing to thread abort controllers around.
    return new Promise((resolve) => {
      const timer = window.setTimeout(
        () => {
          if (token === sequenceToken) {
            resolve();
          }
        },
        Math.max(0, ms),
      );

      timers.push(timer);
    });
  }


  async function typeLine(line: string, token: number): Promise<void> {
    // Each line gets its own cursor so the typing effect feels like a real shell
    // prompt rather than one global cursor teleporting around the log.
    const row = document.createElement('div');

    row.className = 'terminal__line';

    const cursor = createCursor();

    row.appendChild(cursor);
    log.appendChild(row);

    for (let index = 0; index < line.length; index += 1) {
      if (token !== sequenceToken) {
        return;
      }

      const chunk = line[index];

      // Insert before the cursor so the block character always stays at the end
      // of the visible line while text streams in.
      row.insertBefore(document.createTextNode(chunk), cursor);
      log.scrollTop = log.scrollHeight;
      await wait(TYPING_MS_PER_CHAR, token);
    }

    cursor.remove();
  }

  function createCursor(): HTMLSpanElement {
    const cursor = document.createElement('span');

    cursor.className = 'terminal__cursor';
    cursor.textContent = '█';

    return cursor;
  }

  return {
    async show(
      lines: InitializationLine[],
      onComplete: () => void,
      ready?: Promise<void>,
      options?: { minTerminalTimeMs?: number },
    ) {
      // Starting a new show() always invalidates any prior sequence first.
      clearTimers();
      sequenceToken += 1;
      const token = sequenceToken;

      overlay.hidden = false;
      overlay.classList.remove('is-hidden');

      const startTime = performance.now();
      const minTerminalTimeMs = options?.minTerminalTimeMs ?? MIN_TERMINAL_TIME_MS;
      let videoLoaded = !ready;
      let unused = [...lines];

      if (ready) {
        void ready.then(() => {
          videoLoaded = true;
        });
      }

      let lineIndex = 0;

      // Type random lines from the pool until the minimum time has elapsed AND
      // the video is loaded. If the video loads early we still honour the
      // minimum to avoid a jarring flash; if it loads late the terminal keeps
      // streaming new lines so the screen never feels frozen.
      while (token === sequenceToken) {
        if (unused.length === 0) {
          unused = [...lines];
        }

        const pickIndex = Math.floor(Math.random() * unused.length);
        const [line] = unused.splice(pickIndex, 1);

        const stampedLine = `${formatTimestamp(lineIndex)} ${line.text}`;

        lineIndex += 1;
        await typeLine(stampedLine, token);

        if (token !== sequenceToken) return;

        const elapsed = performance.now() - startTime;

        if (elapsed >= minTerminalTimeMs && videoLoaded) {
          break;
        }
      }

      if (token !== sequenceToken) return;

      const syncingRow = document.createElement('div');

      syncingRow.className = 'terminal__line terminal__line--syncing';
      syncingRow.textContent = `${formatTimestamp(lineIndex)} STARTING SIMULATION...`;
      log.appendChild(syncingRow);
      log.scrollTop = log.scrollHeight;

      await wait(FINAL_PAUSE_MS, token);

      if (token === sequenceToken) {
        onComplete();
      }
    },
    hide() {
      clearTimers();
      sequenceToken += 1;
      overlay.hidden = true;
      overlay.classList.add('is-hidden');
      log.innerHTML = '';
    },
  };
}

function formatTimestamp(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;

  return `[${pad(hours)}:${pad(minutes)}:${pad(seconds)}]`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
