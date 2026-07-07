import {
  fetchWithOnlineAssetFallback,
  resolveOnlineAssetUrl,
} from '../shared/online-assets.ts';
import { withQueryParam } from '../shared/urls.ts';

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
 *   • `prewarmSources()` runs detached `<video>` preloading + full-Blob
 *     fetches for likely-next views *after* the active video is revealed.
 *   • `setSource()` silently substitutes a primed Blob URL for the remote
 *     URL, so the caller (app-shell) can stay simple and never worry about
 *     whether the video is local or remote.
 *   • `clearPrewarmedSources()` revokes everything when the run changes,
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
  seekToFraction: (fraction: number, options?: ViewportSeekOptions) => void;

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

  /** Return a pre-fetched blob URL if one was primed by prewarmSources. */
  getPrewarmedBlobUrl: (src: string) => string | null;

  /** Capture the current video frame as a data URL, or null if unavailable. */
  captureFrame: () => string | null;

  /** Load or clear an optional low-res scrub proxy source. */
  setScrubSource: (src: string | null) => void;

  /** Whether an optional low-res scrub proxy is currently available. */
  hasScrubSource: () => boolean;

  /** Show or hide the optional scrub proxy while dragging. */
  setScrubPreviewActive: (active: boolean) => void;

  /** Seek the optional scrub proxy by normalized fraction 0..1. */
  seekScrubPreviewToFraction: (fraction: number, options?: ViewportSeekOptions) => void;
}

export interface ViewportSourceOptions {
  seekFraction?: number;
  autoplay?: boolean;
  ownedObjectUrl?: boolean;
}

export interface ViewportSeekOptions {
  approximate?: boolean;
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
  const scrubPreview = document.createElement('video');

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
  scrubPreview.className = 'viewport__scrub-preview';
  scrubPreview.setAttribute('aria-hidden', 'true');
  scrubPreview.crossOrigin = 'anonymous';
  scrubPreview.loop = false;
  scrubPreview.muted = true;
  scrubPreview.playsInline = true;
  scrubPreview.preload = 'auto';

  viewport.appendChild(video);
  viewport.appendChild(scrubPreview);
  container.appendChild(viewport);

  let timeUpdateCallback: ((fraction: number) => void) | undefined;
  let endedCallback: (() => void) | undefined;
  let playStateCallback: ((isPaused: boolean) => void) | undefined;
  let wantedPrewarmSources = new Set<string>();
  let prewarmingSuspended = false;
  const prewarmedVideos = new Map<string, HTMLVideoElement>();
  const prewarmedBlobUrls = new Map<string, string>();
  const prewarmFetchControllers = new Map<string, AbortController>();
  let ownedObjectUrl: string | null = null;
  let lastFrameDataUrl: string | null = null;
  const frameCaptureCanvas = document.createElement('canvas');
  const frameCaptureContext = frameCaptureCanvas.getContext('2d');
  let scrubPreviewActive = false;
  let scrubPreviewSrc: string | null = null;

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

  scrubPreview.addEventListener('loadeddata', () => {
    if (scrubPreviewActive) {
      scrubPreview.classList.add('is-visible');
    }
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
    const primedBlobUrl = prewarmedBlobUrls.get(src);

    if (primedBlobUrl) {
      prewarmedBlobUrls.delete(src);
      options = { ...options, ownedObjectUrl: true };

      src = primedBlobUrl;
    }

    // Fade out first so swapping sources feels deliberate rather than like a
    // hard cut between two unrelated videos.
    video.classList.add('fade-out');

    window.setTimeout(() => {
      // If the requested source is already loaded, just cancel the fade and keep
      // the current video. There is no need to flush playback state.
      if (video.src.endsWith(src)) {
        video.classList.remove('fade-out');

        return;
      }

      const resumeMuted = video.muted;
      const seekFraction = options.seekFraction;

      releaseOwnedObjectUrl();
      lastFrameDataUrl = null;
      scrubPreview.classList.remove('is-visible');
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
    scrubPreview.classList.remove('is-visible');
  }

  function clearSource(): void {
    releaseOwnedObjectUrl();
    video.removeAttribute('src');
    video.load();
    lastFrameDataUrl = null;
    scrubPreview.classList.remove('is-visible');
  }

  function showMedia(): void {
    video.classList.remove('is-empty');
  }

  function seekToFraction(fraction: number, options: ViewportSeekOptions = {}): void {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }

    // Clamp aggressively so scrubbing never asks the media element for a time
    // outside its real bounds.
    const clamped = Math.max(0, Math.min(1, fraction));
    const nextTime = clamped * video.duration;

    if (options.approximate && typeof video.fastSeek === 'function') {
      video.fastSeek(nextTime);

      return;
    }

    video.currentTime = nextTime;
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

    for (const [src, controller] of prewarmFetchControllers.entries()) {
      if (wantedPrewarmSources.has(src)) {
        continue;
      }

      controller.abort();
      prewarmFetchControllers.delete(src);
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

      if (prewarmedBlobUrls.has(src) || prewarmFetchControllers.has(src)) {
        continue;
      }

      startPrewarmBlobFetch(src);
    }
  }

  function stopDetachedPrewarmedVideos(): void {
    for (const prewarmedVideo of prewarmedVideos.values()) {
      prewarmedVideo.removeAttribute('src');
      prewarmedVideo.load();
    }

    prewarmedVideos.clear();
  }

  function abortPrewarmFetches(): void {
    for (const controller of prewarmFetchControllers.values()) {
      controller.abort();
    }

    prewarmFetchControllers.clear();
  }

  function startPrewarmBlobFetch(src: string): void {
    const controller = new AbortController();

    prewarmFetchControllers.set(src, controller);

    const cacheBustedUrl = withQueryParam(src, '_', `${Date.now()}`);

    void fetchWithOnlineAssetFallback(cacheBustedUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          return;
        }

        const blob = await response.blob();

        if (!wantedPrewarmSources.has(src)) {
          return;
        }

        prewarmedBlobUrls.set(src, URL.createObjectURL(blob));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      })
      .finally(() => {
        if (prewarmFetchControllers.get(src) === controller) {
          prewarmFetchControllers.delete(src);
        }
      });
  }

  function clearPrewarmedSources(): void {
    wantedPrewarmSources.clear();
    prewarmingSuspended = false;
    stopDetachedPrewarmedVideos();
    abortPrewarmFetches();

    for (const blobUrl of prewarmedBlobUrls.values()) {
      URL.revokeObjectURL(blobUrl);
    }

    prewarmedBlobUrls.clear();
  }

  function getPrewarmedBlobUrl(src: string): string | null {
    return prewarmedBlobUrls.get(src) ?? null;
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

  function setScrubPreviewActive(active: boolean): void {
    scrubPreviewActive = active;
    viewport.classList.remove('is-scrub-handoff');

    if (active && scrubPreviewSrc !== null) {
      viewport.classList.add('is-scrubbing');
    } else {
      viewport.classList.remove('is-scrubbing');
    }

    if (!active || !scrubPreviewSrc) {
      if (scrubPreview.classList.contains('is-visible')) {
        viewport.classList.add('is-scrub-handoff');
        requestAnimationFrame(() => {
          scrubPreview.classList.remove('is-visible');
          requestAnimationFrame(() => {
            viewport.classList.remove('is-scrub-handoff');
          });
        });
      }

      return;
    }

    if (scrubPreview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      scrubPreview.classList.add('is-visible');
    }
  }

  function setScrubSource(src: string | null): void {
    scrubPreviewSrc = src;
    scrubPreviewActive = false;
    viewport.classList.remove('is-scrubbing');
    scrubPreview.classList.remove('is-visible');

    if (!src) {
      scrubPreview.removeAttribute('src');
      scrubPreview.load();

      return;
    }

    if (scrubPreview.src.endsWith(src)) {
      return;
    }

    scrubPreview.src = src;
    scrubPreview.load();
  }

  function hasScrubSource(): boolean {
    return scrubPreviewSrc !== null;
  }

  function seekScrubPreviewToFraction(
    fraction: number,
    options: ViewportSeekOptions = {},
  ): void {
    if (
      scrubPreviewSrc === null ||
      !Number.isFinite(scrubPreview.duration) ||
      scrubPreview.duration <= 0
    ) {
      return;
    }

    const clamped = Math.max(0, Math.min(1, fraction));
    const nextTime = clamped * scrubPreview.duration;

    if (options.approximate && typeof scrubPreview.fastSeek === 'function') {
      scrubPreview.fastSeek(nextTime);

      return;
    }

    scrubPreview.currentTime = nextTime;
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
    getPrewarmedBlobUrl,
    captureFrame,
    setScrubSource,
    hasScrubSource,
    setScrubPreviewActive,
    seekScrubPreviewToFraction,
  };
}
