import {
  fetchWithOnlineAssetFallback,
  resolveOnlineAssetUrl,
} from '../shared/online-assets.ts';

/**
 * Viewport — full-page background layer for simulation media.
 *
 * The viewport hosts a real video element. Media is visually hidden until
 * initialization finishes, so the display only "comes alive" once ready.
 *
 * ── Loading philosophy ─────────────────────────────────────────────────
 * This module tries to keep tab switches and re-seeks network-free wherever
 * possible while avoiding premature prewarm work that would compete with
 * the active video's initial buffer.
 *
 *   • The active video uses `preload="auto"` so the browser can fetch ahead.
 *   • `prewarmSources()` runs detached `<video>` preloading for likely-next
 *     views after the active video is revealed.
 *   • `clearPrewarmedSources()` tears down detached preloaders when the run changes,
 *     keeping memory and object-URL references clean.
 */

export interface ViewportController {
  /** Swap the active video source, optionally preserving position/autoplaying. */
  setSource: (src: string, options?: ViewportSourceOptions) => void;

  /** Toggle media muting. */
  setMuted: (muted: boolean) => void;

  /** Start playback. */
  play: () => Promise<void>;

  /** Pause playback. */
  pause: () => void;

  /** Visually hide the media element while keeping it mounted. */
  hideMedia: () => void;

  /** Clear the active media source and any cached frame capture. */
  clearSource: () => void;

  /** Reveal the media element again. */
  showMedia: () => void;

  /** Seek by normalized fraction 0..1. */
  seekToFraction: (fraction: number) => void;

  /** Reset playback back to the start. */
  resetPlayback: () => void;

  /** Wait for the current source to have decoded initial media data. */
  waitForLoadedData: (timeoutMs?: number) => Promise<void>;

  /** Wait until the current source has buffered ahead by the requested amount. */
  waitForBufferedAhead: (minSeconds: number, timeoutMs?: number) => Promise<void>;

  /** Wait until the current seek operation has settled enough to render. */
  waitForSeekSettled: (timeoutMs?: number) => Promise<void>;

  /** Subscribe to normalized time updates. */
  onTimeUpdate: (callback: (fraction: number) => void) => void;

  /** Subscribe to playback-end notifications. */
  onEnded: (callback: () => void) => void;

  /** Read the current media duration in seconds. */
  getDurationSeconds: () => number;

  /** Read the current playback position in seconds. */
  getCurrentTimeSeconds: () => number;

  /** Read the current playback position as a normalized fraction. */
  getPlaybackFraction: () => number;

  /** Whether playback is currently paused. */
  isPaused: () => boolean;

  /** Set video playback rate (0.25, 0.5, 1, etc.). */
  setPlaybackRate: (rate: number) => void;

  /** Read the current playback rate. */
  getPlaybackRate: () => number;

  /** Subscribe to play/pause/ended state changes. */
  onPlayStateChange: (callback: (isPaused: boolean) => void) => void;

  /** Access the root viewport element. */
  getElement: () => HTMLElement;

  /** Ask the browser to begin buffering a set of likely-next videos. */
  prewarmSources: (sources: string[]) => void;

  /** Pause alternate-view prewarming without discarding finished blob caches. */
  suspendPrewarming: () => void;

  /** Resume alternate-view prewarming for the most recently requested sources. */
  resumePrewarming: () => void;

  /** Drop any prewarmed video elements for the previous run. */
  clearPrewarmedSources: () => void;

  /** Capture the current video frame as a data URL, or null if unavailable. */
  captureFrame: () => string | null;
}

export interface ViewportSourceOptions {
  seekFraction?: number;
  autoplay?: boolean;
  ownedObjectUrl?: boolean;
}

/**
 * Create and mount the viewport media layer.
 *
 * @param container - Root app node to mount into.
 * @param initialSrc - Initial video URL to load.
 * @returns Controller for manipulating playback and subscribing to events.
 */
export function createViewport(
  container: HTMLElement,
  initialSrc: string,
): ViewportController {
  // The viewport wrapper gives CSS one stable full-screen layer to position and
  // animate independently from every overlay/chrome element above it.
  const viewport = document.createElement('div');

  viewport.className = 'viewport';

  // We use a real <video> so browser playback, seeking, and buffering work out
  // of the box. The rest of this module is mostly a light controller wrapper.
  const video = document.createElement('video');

  video.className = 'viewport__media is-empty';
  // Summary capture draws the video into a canvas. Mark the media element as
  // CORS-enabled up front so progressively loaded cross-origin assets remain
  // readable when the host serves the required CORS headers.
  video.crossOrigin = 'anonymous';
  video.src = initialSrc;
  video.loop = false;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', 'Simulation output');

  viewport.appendChild(video);
  container.appendChild(viewport);

  let timeUpdateCallback: ((fraction: number) => void) | undefined;
  let endedCallback: (() => void) | undefined;
  let playStateCallback: ((isPaused: boolean) => void) | undefined;
  let wantedPrewarmSources = new Set<string>();
  let prewarmingSuspended = false;
  const prewarmedVideos = new Map<string, HTMLVideoElement>();
  let ownedObjectUrl: string | null = null;
  let lastFrameDataUrl: string | null = null;
  const frameCaptureCanvas = document.createElement('canvas');
  const frameCaptureContext = frameCaptureCanvas.getContext('2d');

  video.addEventListener('play', () => playStateCallback?.(false));
  video.addEventListener('pause', () => playStateCallback?.(true));
  video.addEventListener('ended', () => playStateCallback?.(true));

  // Convert native video time updates into normalized 0..1 progress so the
  // rest of the app never needs to think about seconds vs duration.
  video.addEventListener('timeupdate', () => {
    if (
      !timeUpdateCallback ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    ) {
      return;
    }

    timeUpdateCallback(video.currentTime / video.duration);
  });

  video.addEventListener('ended', () => {
    endedCallback?.();
  });

  // Persist the desired playback rate across source swaps so the user's
  // speed preference survives view switches and run restarts.
  let desiredRate = video.playbackRate;

  function releaseOwnedObjectUrl(): void {
    if (!ownedObjectUrl) {
      return;
    }

    URL.revokeObjectURL(ownedObjectUrl);
    ownedObjectUrl = null;
  }

  function setSource(src: string, options: ViewportSourceOptions = {}): void {
    // Fade out first so swapping sources feels deliberate rather than like a
    // hard cut between two unrelated videos.
    video.classList.add('fade-out');

    window.setTimeout(() => {
      // If the requested source is already loaded, just cancel the fade and keep
      // the current video, but still honour any requested seek/reset behavior.
      if (video.src.endsWith(src)) {
        const seekFraction = options.seekFraction;

        if (
          seekFraction !== undefined &&
          Number.isFinite(video.duration) &&
          video.duration > 0
        ) {
          const clamped = Math.max(0, Math.min(0.999, seekFraction));

          video.currentTime = clamped * video.duration;
        } else {
          video.currentTime = 0;
        }

        video.playbackRate = desiredRate;
        video.classList.remove('fade-out');

        if (options.autoplay) {
          void video.play().catch(() => {});
        }

        return;
      }

      const resumeMuted = video.muted;
      const seekFraction = options.seekFraction;

      releaseOwnedObjectUrl();
      lastFrameDataUrl = null;
      ownedObjectUrl = options.ownedObjectUrl ? src : null;

      // Replace the source and wait for media data before seeking/autoplaying.
      video.src = src;
      video.load();

      video.onloadeddata = () => {
        video.muted = resumeMuted;

        // Optional seek lets view-switching preserve playback position across
        // alternate renders of the same simulation.
        if (
          seekFraction !== undefined &&
          Number.isFinite(video.duration) &&
          video.duration > 0
        ) {
          const clamped = Math.max(0, Math.min(0.999, seekFraction));

          video.currentTime = clamped * video.duration;
        } else {
          video.currentTime = 0;
        }

        video.playbackRate = desiredRate;
        video.classList.remove('fade-out');

        if (options.autoplay) {
          // Autoplay can legitimately fail on some browsers. The shell handles
          // that gracefully, so we intentionally swallow the rejection here.
          void video.play().catch(() => {});
        }
      };
    }, 120);
  }

  function setMuted(muted: boolean): void {
    video.muted = muted;
  }

  async function play(): Promise<void> {
    await video.play();
  }

  function pause(): void {
    video.pause();
  }

  function hideMedia(): void {
    video.classList.add('is-empty');
  }

  function clearSource(): void {
    releaseOwnedObjectUrl();
    video.removeAttribute('src');
    video.load();
    lastFrameDataUrl = null;
  }

  function showMedia(): void {
    video.classList.remove('is-empty');
  }

  function seekToFraction(fraction: number): void {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }

    // Clamp aggressively so scrubbing never asks the media element for a time
    // outside its real bounds.
    const clamped = Math.max(0, Math.min(1, fraction));
    video.currentTime = clamped * video.duration;
  }

  function resetPlayback(): void {
    // Reset both the media element and any subscribed UI (timeline/HUD).
    video.currentTime = 0;
    timeUpdateCallback?.(0);
  }

  function waitForLoadedData(timeoutMs = 8000): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const handleLoaded = () => {
        cleanup();
        resolve();
      };
      const handleTimeout = window.setTimeout(
        () => {
          cleanup();
          resolve();
        },
        Math.max(0, timeoutMs),
      );

      function cleanup() {
        window.clearTimeout(handleTimeout);
        video.removeEventListener('loadeddata', handleLoaded);
      }

      video.addEventListener('loadeddata', handleLoaded, { once: true });
    });
  }

  function waitForBufferedAhead(minSeconds: number, timeoutMs = 8000): Promise<void> {
    const target = Math.max(0, minSeconds);

    if (target === 0 || hasBufferedAhead(target)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const handleProgress = () => {
        if (!hasBufferedAhead(target)) {
          return;
        }

        cleanup();
        resolve();
      };
      const handleTimeout = window.setTimeout(
        () => {
          cleanup();
          resolve();
        },
        Math.max(0, timeoutMs),
      );

      function cleanup() {
        window.clearTimeout(handleTimeout);
        video.removeEventListener('progress', handleProgress);
        video.removeEventListener('canplay', handleProgress);
        video.removeEventListener('loadeddata', handleProgress);
      }

      video.addEventListener('progress', handleProgress);
      video.addEventListener('canplay', handleProgress);
      video.addEventListener('loadeddata', handleProgress);
      handleProgress();
    });
  }

  function waitForSeekSettled(timeoutMs = 250): Promise<void> {
    if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const handleSettled = () => {
        if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          return;
        }

        cleanup();
        resolve();
      };
      const handleTimeout = window.setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, timeoutMs));

      function cleanup() {
        window.clearTimeout(handleTimeout);
        video.removeEventListener('seeked', handleSettled);
        video.removeEventListener('canplay', handleSettled);
        video.removeEventListener('loadeddata', handleSettled);
      }

      video.addEventListener('seeked', handleSettled);
      video.addEventListener('canplay', handleSettled);
      video.addEventListener('loadeddata', handleSettled);
      handleSettled();
    });
  }

  function hasBufferedAhead(minSeconds: number): boolean {
    const currentTime = video.currentTime;

    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);

      if (currentTime < start || currentTime > end) {
        continue;
      }

      return end - currentTime >= minSeconds;
    }

    return false;
  }

  function prewarmSources(sources: string[]): void {
    wantedPrewarmSources = new Set(
      sources.filter(Boolean).filter((src) => src !== video.currentSrc),
    );

    if (!prewarmingSuspended) {
      syncPrewarmedSources();
    }
  }

  function suspendPrewarming(): void {
    prewarmingSuspended = true;
    stopDetachedPrewarmedVideos();
    abortPrewarmFetches();
  }

  function resumePrewarming(): void {
    if (!prewarmingSuspended) {
      syncPrewarmedSources();

      return;
    }

    prewarmingSuspended = false;
    syncPrewarmedSources();
  }

  function syncPrewarmedSources(): void {
    for (const [src, prewarmedVideo] of prewarmedVideos.entries()) {
      if (wantedPrewarmSources.has(src)) {
        continue;
      }

      prewarmedVideo.removeAttribute('src');
      prewarmedVideo.load();
      prewarmedVideos.delete(src);
    }

    for (const src of wantedPrewarmSources) {
      if (!prewarmedVideos.has(src)) {
        const prewarmedVideo = document.createElement('video');

        prewarmedVideo.preload = 'auto';
        prewarmedVideo.crossOrigin = 'anonymous';
        prewarmedVideo.muted = true;
        prewarmedVideo.playsInline = true;
        prewarmedVideo.src = resolveOnlineAssetUrl(src);
        prewarmedVideo.load();
        prewarmedVideos.set(src, prewarmedVideo);
      }
    }
  }

  function stopDetachedPrewarmedVideos(): void {
    for (const prewarmedVideo of prewarmedVideos.values()) {
      prewarmedVideo.removeAttribute('src');
      prewarmedVideo.load();
    }

    prewarmedVideos.clear();
  }

  function clearPrewarmedSources(): void {
    wantedPrewarmSources.clear();
    prewarmingSuspended = false;
    stopDetachedPrewarmedVideos();
  }

  function storeCurrentFrame(): void {
    if (
      !frameCaptureContext ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    frameCaptureCanvas.width = video.videoWidth;
    frameCaptureCanvas.height = video.videoHeight;

    try {
      frameCaptureContext.drawImage(
        video,
        0,
        0,
        frameCaptureCanvas.width,
        frameCaptureCanvas.height,
      );
      lastFrameDataUrl = frameCaptureCanvas.toDataURL('image/jpeg', 0.85);
    } catch {
      // A failed thumbnail capture should never block the summary overlay.
      lastFrameDataUrl = null;
    }
  }

  function captureFrame(): string | null {
    storeCurrentFrame();

    return lastFrameDataUrl;
  }

  function onTimeUpdate(callback: (fraction: number) => void): void {
    timeUpdateCallback = callback;
  }

  function onEnded(callback: () => void): void {
    endedCallback = callback;
  }

  return {
    setSource,
    setMuted,
    play,
    pause,
    hideMedia,
    clearSource,
    showMedia,
    seekToFraction,
    resetPlayback,
    waitForLoadedData,
    waitForBufferedAhead,
    waitForSeekSettled,
    onTimeUpdate,
    onEnded,
    getDurationSeconds: () => (Number.isFinite(video.duration) ? video.duration : 0),
    getCurrentTimeSeconds: () => (Number.isFinite(video.currentTime) ? video.currentTime : 0),
    getPlaybackFraction: () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        return 0;
      }

      return video.currentTime / video.duration;
    },
    isPaused: () => video.paused,
    setPlaybackRate: (rate: number) => {
      desiredRate = rate;
      video.playbackRate = rate;
    },
    getPlaybackRate: () => desiredRate,
    onPlayStateChange: (callback: (isPaused: boolean) => void) => {
      playStateCallback = callback;
    },
    getElement: () => viewport,
    prewarmSources,
    suspendPrewarming,
    resumePrewarming,
    clearPrewarmedSources,
    captureFrame,
  };
}
