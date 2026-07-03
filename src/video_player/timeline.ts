/**
 * Display-mode timeline scrubber with playback controls.
 *
 * Renders a thin translucent control bar containing a mute button, a
 * play/pause button, a range-input scrubber, and a playback-speed
 * selector. All callbacks are delegated to the shell so the timeline
 * stays stateless.
 */

export interface TimelineController {
  /** Update the visible thumb position from normalized playback progress. */
  setPosition: (t: number) => void;

  /** Update the play/pause button visual state. */
  setPlaying: (playing: boolean) => void;

  /** Update the speed selector label. */
  setSpeed: (rate: number) => void;

  /** Show or hide the audio mute control. */
  setAudioVisible: (visible: boolean) => void;

  /** Update the mute button visual state. */
  setMuted: (muted: boolean) => void;
}

export type TimelineChangeCallback = (position: number) => void;

interface TimelineOptions {
  /** Called when the user scrubs the slider (receives 0..1). */
  onChange?: TimelineChangeCallback;

  /** Called when the user clicks the play/pause button. */
  onTogglePlay?: () => void;

  /** Called when the user picks a speed from the dropdown. */
  onSpeedChange?: (rate: number) => void;

  /** Called when the user clicks the summary button. */
  onSummaryClick?: () => void;

  /** Called when the user clicks the audio mute button. */
  onAudioToggle?: () => void;

  /** Called when the user starts dragging the scrubber. */
  onScrubStart?: () => void;

  /** Called when the user finishes dragging the scrubber. */
  onScrubEnd?: () => void;

  /** Initial playback rate label (e.g. 1 for "x1"). */
  initialSpeed?: number;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2] as const;

/**
 * Create and mount the timeline control bar.
 *
 * @param container - Host element to mount into.
 * @param options  - Callback hooks for scrub / play-toggle / speed-change.
 * @returns Controller for updating the thumb, play state, and speed label.
 */
export function createTimeline(
  container: HTMLElement,
  options: TimelineOptions = {},
): TimelineController {
  const {
    onChange,
    onTogglePlay,
    onSpeedChange,
    onSummaryClick,
    onAudioToggle,
    onScrubStart,
    onScrubEnd,
    initialSpeed = 1,
  } = options;

  const timeline = document.createElement('div');
  let isScrubbing = false;

  timeline.className = 'timeline';

  const barRow = document.createElement('div');

  barRow.className = 'timeline__bar-row';

  const audioWrap = document.createElement('div');

  audioWrap.className = 'timeline__audio is-hidden';

  const audioBtn = document.createElement('button');

  audioBtn.className = 'timeline__audio-btn';
  audioBtn.type = 'button';
  audioBtn.setAttribute('aria-label', 'Toggle audio mute');
  audioBtn.innerHTML = createSpeakerSvg();
  audioBtn.addEventListener('click', () => onAudioToggle?.());

  audioWrap.appendChild(audioBtn);

  const playBtn = document.createElement('button');

  playBtn.className = 'timeline__play-btn';
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Toggle playback');
  playBtn.addEventListener('click', () => onTogglePlay?.());

  const slider = document.createElement('input');

  slider.className = 'timeline__slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.value = '0';
  slider.style.setProperty('--fill', '0%');
  slider.setAttribute('aria-label', 'Simulation time');

  const speedWrap = document.createElement('div');

  speedWrap.className = 'timeline__speed';

  const speedBtn = document.createElement('button');

  speedBtn.className = 'timeline__speed-btn';
  speedBtn.type = 'button';
  speedBtn.setAttribute('aria-label', 'Playback speed');
  speedBtn.addEventListener('click', () => {
    speedWrap.classList.toggle('open');
  });

  const speedMenu = document.createElement('div');

  speedMenu.className = 'timeline__speed-menu';

  for (const rate of SPEED_OPTIONS) {
    const option = document.createElement('button');

    option.className = 'timeline__speed-option';
    option.type = 'button';
    option.textContent = formatSpeed(rate);
    option.addEventListener('click', () => {
      speedWrap.classList.remove('open');
      onSpeedChange?.(rate);
    });
    speedMenu.appendChild(option);
  }

  speedWrap.appendChild(speedBtn);
  speedWrap.appendChild(speedMenu);

  const summaryBtn = document.createElement('button');

  summaryBtn.className = 'timeline__summary-btn';
  summaryBtn.type = 'button';
  summaryBtn.setAttribute('aria-label', 'View run summary');
  summaryBtn.textContent = '\u24D8';
  summaryBtn.addEventListener('click', () => onSummaryClick?.());

  barRow.appendChild(audioWrap);
  barRow.appendChild(playBtn);
  barRow.appendChild(slider);
  barRow.appendChild(speedWrap);
  barRow.appendChild(summaryBtn);

  let pendingPosition: number | null = null;
  let scheduledRafId: number | null = null;

  slider.addEventListener('input', () => {
    const position = parseInt(slider.value, 10) / 1000;

    slider.style.setProperty('--fill', `${position * 100}%`);
    pendingPosition = position;

    if (scheduledRafId !== null) return;

    scheduledRafId = requestAnimationFrame(() => {
      scheduledRafId = null;
      if (pendingPosition === null) return;
      const positionToSend = pendingPosition;
      pendingPosition = null;
      onChange?.(positionToSend);
    });
  });

  slider.addEventListener('pointerdown', () => {
    if (isScrubbing) {
      return;
    }

    isScrubbing = true;
    onScrubStart?.();
  });
  slider.addEventListener('pointerup', () => {
    if (!isScrubbing) {
      return;
    }

    isScrubbing = false;
    onScrubEnd?.();
  });
  slider.addEventListener('change', () => {
    if (!isScrubbing) {
      return;
    }

    isScrubbing = false;
    onScrubEnd?.();
  });

  document.addEventListener('click', (event) => {
    if (!speedWrap.contains(event.target as Node)) {
      speedWrap.classList.remove('open');
    }
  });

  timeline.appendChild(barRow);
  container.appendChild(timeline);

  setSpeedLabel(initialSpeed);

  return {
    setPosition(t: number) {
      const clamped = Math.max(0, Math.min(1, t));

      slider.value = String(Math.round(clamped * 1000));
      slider.style.setProperty('--fill', `${clamped * 100}%`);
    },
    setPlaying(playing: boolean) {
      playBtn.textContent = playing ? '\u275A\u275A\uFE0E' : '\u25B6\uFE0E';
      playBtn.classList.toggle('is-paused', !playing);
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    },
    setSpeed(rate: number) {
      setSpeedLabel(rate);
    },
    setAudioVisible(visible: boolean) {
      audioWrap.hidden = !visible;
      audioWrap.classList.toggle('is-hidden', !visible);
    },
    setMuted(muted: boolean) {
      audioBtn.classList.toggle('is-muted', muted);
      audioBtn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    },
  };

  function setSpeedLabel(rate: number) {
    speedBtn.textContent = formatSpeed(rate);

    for (const child of speedMenu.children) {
      child.classList.toggle('is-active', child.textContent === formatSpeed(rate));
    }
  }
}

function formatSpeed(rate: number): string {
  return `x${rate}`;
}

function createSpeakerSvg(): string {
  return `
    <svg class="timeline__audio-icon" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path class="timeline__audio-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path class="timeline__audio-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <line class="timeline__audio-mute-x" x1="3" y1="3" x2="21" y2="21"
            stroke="currentColor" stroke-width="2" />
    </svg>`;
}
