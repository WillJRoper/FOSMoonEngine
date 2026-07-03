/**
 * Application shell.
 *
 * This module owns the assembled MoonEngine experience after the HTML mount
 * node has been located. It is still fairly large, but moving it out of
 * `src/main.ts` is the first step toward a cleaner app-layer split where boot,
 * orchestration, and domain logic are separated more clearly.
 */

import {
  SIMULATION_CLASSES,
  type SimulationClass,
} from '../selection/simulation-catalog.ts';
import { applyTheme, getInitialTheme, type ThemeId } from '../selection/theme.ts';
import { createViewport } from '../video_player/viewport.ts';
import { createTimeline } from '../video_player/timeline.ts';
import { createTelemetryPanel } from '../live-data/hud.ts';
import { createEntryInfoOverlay } from '../entry/entry-info-overlay.ts';
import { createSummaryOverlay } from '../summaries/summary-overlay.ts';
import { createViewSwitcher } from '../video_player/view-switcher.ts';
import {
  createOverlayPanel,
  type OverlayPanelView,
} from '../selection/overlay-panel.ts';
import { createLoadingOverlay } from '../loading/overlay.ts';
import { createDisplayMenu } from './display-menu.ts';
import {
  loadPlaybackSpeed,
  persistPlaybackSpeed,
  playViewportWithMutedFallback,
} from './playback.ts';
import { createRunRequestController } from './run-requests.ts';
import { getInitializationLines } from '../loading/init-text.ts';
import {
  createManifestController,
  getLocalPlaceholderVideo,
  type GalleryManifestRun,
  type VideoMatch,
} from '../selection/placeholder-assets.ts';
import {
  loadVideoRunMetadata,
  type VideoRunMetadata,
} from '../selection/video-run-metadata.ts';
import {
  EMPTY_LIVE_STATS_DATASET,
  loadLiveStatsCsv,
  sampleLiveStats,
  type LiveStatsDataset,
} from '../live-data/csv.ts';
import { countDecimals } from '../shared/format.ts';
import { withBaseUrl } from '../shared/urls.ts';
import { INITIALIZATION } from '../shared/constants.ts';
import {
  getVisibleScaleIds,
  loadAdvancedSettings,
  saveAdvancedSettings,
  type AdvancedSettings,
} from '../shared/advanced-settings.ts';
import {
  logInfo,
  logWarn,
  setVerboseLoggingEnabled,
} from '../shared/logger.ts';
import {
  fetchWithOnlineAssetFallback,
  resolveOnlineAssetUrl,
} from '../shared/online-assets.ts';
import { trackRunSelection } from '../shared/track-run.ts';
import { buildGalleryScene } from '../gallery/gallery-data.ts';
import { createGalleryOverlay } from '../gallery/gallery-overlay.ts';
import {
  getCompletedGalleryRunIds,
  markGalleryRunCompleted,
  resetGalleryProgress,
} from '../gallery/gallery-progress.ts';

type AppMode = 'entry' | 'config' | 'initializing' | 'display';

interface PreparedVideoSource {
  src: string;
  ownedObjectUrl: boolean;
  shouldWaitForBuffer: boolean;
}

const ACTIVE_VIDEO_FULL_FETCH_MAX_BYTES = 50 * 1024 * 1024;
const ACTIVE_VIDEO_BUFFER_SECONDS = 8;
const ACTIVE_VIDEO_BUFFER_WAIT_MS = 6000;
const ACTIVE_VIDEO_LOADED_DATA_WAIT_MS = 8000;
const LOCAL_MANIFEST_MIN_TERMINAL_TIME_MAX_MS = 7000;
const ALTERNATE_PREWARM_RESUME_DELAY_MS = 1200;
const SCRUB_HUD_UPDATE_INTERVAL_MS = 250;
const COLLAPSIBLE_CHROME_IDLE_MS = 2000;
const SCRUB_SEEK_SETTLE_WAIT_MS = 250;
const AUDIO_RESYNC_DRIFT_SECONDS = 1;
const AUDIO_RESYNC_COOLDOWN_MS = 1500;

/** Default visual theme for the planetary scale. */
const SCALE_TO_THEME: Record<string, ThemeId> = {
  planetary: 'matrix',
};

/**
 * Create and run the full application shell inside the provided mount node.
 *
 * The shell is created once and then manages all subsequent mode switches,
 * simulation changes, overlay visibility, media playback, and telemetry updates.
 *
 * @param app - Root mount node (`#app`).
 * @returns void
 */
export function createAppShell(app: HTMLElement): void {
  const scaleIds = SIMULATION_CLASSES.map((simClass) => simClass.id);
  let advancedSettings = loadAdvancedSettings(scaleIds);
  let availableSimulationClasses = getSelectableSimulationClasses(advancedSettings);
  const manifestController = createManifestController();
  const runRequests = createRunRequestController();

  setVerboseLoggingEnabled(advancedSettings.verboseLogging);
  // ── State ────────────────────────────────────────────────────────────────
  // Everything the shell needs to track lives here so it's easy to see what's
  // being managed at a glance. We keep these as closure variables rather than
  // a formal state object because the data is all independently scoped.

  // Start on the first simulation class defined in the catalog.
  let activeClass: SimulationClass =
    getSimulationClassById(advancedSettings.lockedScaleId) ??
    availableSimulationClasses[0] ??
    SIMULATION_CLASSES[0];

  // Load the user's persisted theme immediately so the UI renders in the right
  // color scheme from the very first frame.
  let activeTheme: ThemeId = advancedSettings.lockedScaleId
    ? SCALE_TO_THEME[activeClass.id]
    : getInitialTheme();

  // Track whether the currently loaded video has reached the end — we need this
  // to know if we should re-show the summary overlay.
  let hasCompletedPlayback = false;
  let activeCompletedRunToken = 0;

  // Sidecar run metadata for the currently loaded video (wallclock, compute, etc).
  let activeRunMetadata: VideoRunMetadata | null = null;

  // Optional per-run audio track used by audio-capable views.
  let activeAudioUrl: string | null = null;
  let activeAudioAvailable = false;
  let audioMuted = advancedSettings.audioMutedByDefault;
  let audioVolume = advancedSettings.defaultAudioVolume;
  let audioProbeNonce = 0;
  const knownAvailableAudioUrls = new Set<string>();

  // Manifest-backed run selection for the currently loaded simulation.
  let activeRunMatch: VideoMatch | null = null;
  let activeGalleryRuns: GalleryManifestRun[] = [];
  let restoreSummaryAfterGalleryClose = false;
  let restoreConfigAfterGalleryClose = false;
  let configActiveView: OverlayPanelView = 'parameters';
  let configReturnView: OverlayPanelView | null = null;

  // Last-known playback time in seconds; used to refresh HUD after async loads
  // complete (e.g. CSV parsing or YAML fetch).
  let lastPlaybackSeconds = 0;

  // Hold the currently loaded live-stat frames for the active simulation/video.
  let activeLiveStatsFrames: LiveStatsDataset = EMPTY_LIVE_STATS_DATASET;
  let telemetryEnabled = true;

  // Keep the viewport hidden until a simulation has successfully initialized.
  // This way the video element doesn't flash before the boot sequence finishes.
  let hasCompletedInitialization = false;

  // Persist parameter values per simulation family so users can switch between
  // families without losing their slider positions.
  const valuesByClass = Object.fromEntries(
    SIMULATION_CLASSES.map((simClass) => [
      simClass.id,
      createRandomizedValues(simClass),
    ]),
  ) as Record<string, Record<string, number>>;

  // ── UI Assembly ──────────────────────────────────────────────────────────
  // Build the full DOM tree top-down. Layers stack: viewport at the bottom,
  // chrome overlays in the middle, modal overlays on top.

  // Apply the theme before assembling UI so token-based styling is ready before
  // any element references a CSS custom property.
  applyTheme(activeTheme);

  // Use the active family to choose the initial local placeholder video.
  const initialPlaceholderVideo = getLocalPlaceholderVideo(activeClass.id);

  // Mount the persistent viewport layer first so every overlay can sit above it.
  // The viewport stays mounted forever — only its source video changes.
  const viewport = createViewport(app, initialPlaceholderVideo);
  const runAudio = document.createElement('audio');

  runAudio.preload = 'auto';
  runAudio.hidden = true;
  runAudio.setAttribute('playsinline', 'true');
  runAudio.muted = audioMuted;
  runAudio.volume = audioVolume;
  app.appendChild(runAudio);

  // Build the display HUD container that appears in config/display contexts.
  const displayChrome = document.createElement('div');

  displayChrome.className = 'display-chrome';
  displayChrome.classList.add('is-hidden');
  app.appendChild(displayChrome);

  // Persistent SWIFT logo — bottom-right corner for subtle attribution.
  const swiftLogo = document.createElement('div');

  swiftLogo.className = 'swift-logo';
  swiftLogo.innerHTML = `
    <img
      class="swift-logo__image"
      src="${withBaseUrl('assets/credits/swift-logo.webp')}"
      alt="SWIFT"
      decoding="async"
    />
    <img
      class="swift-logo__image-compact"
      src="${withBaseUrl('assets/credits/swift-logo-compact.webp')}"
      alt="SWIFT"
      decoding="async"
    />
  `;
  app.appendChild(swiftLogo);
  // Build the burger-menu host in the upper-left corner of the app.
  // Mounted outside displayChrome so it is available on the landing page too.
  const topLeft = document.createElement('div');

  topLeft.className = 'display-chrome__top-left is-hidden';
  app.appendChild(topLeft);

  // Mount the display menu and delegate actions back into the shell state.
  // The menu doesn't know about modes or state — it just fires callbacks.
  const displayMenu = createDisplayMenu(topLeft, {
    onParameters() {
      openConfigPanel('parameters');
    },
    onViewSelected(view) {
      if (view === 'gallery') {
        void openGallery();

        return;
      }

      if (view === 'credits') {
        openConfigPanel('credits');

        return;
      }

      openConfigPanel(view);
    },
  });

  displayMenu.setFullscreenVisible(!advancedSettings.lockFullscreen);

  // Left-center slot: the view-switcher that appears when a run has multiple
  // video views available (e.g. multiple simulation outputs).
  const leftCenter = document.createElement('div');

  leftCenter.className = 'display-chrome__left-center';
  displayChrome.appendChild(leftCenter);
  const viewSwitcher = createViewSwitcher(leftCenter, {
    onSelect(viewId) {
      handleViewSelection(viewId);
    },
    onInfo(_viewId, label, description) {
      infoOverlayTitle.textContent = label;
      infoOverlayText.textContent = description;
      infoOverlay.classList.add('is-visible');
    },
  });

  const infoOverlay = document.createElement('div');

  infoOverlay.className = 'view-info-overlay';
  infoOverlay.innerHTML = `
    <div class="view-info-overlay__card">
      <button class="view-info-overlay__close" type="button" aria-label="Close">&times;</button>
      <h3 class="view-info-overlay__title"></h3>
      <p class="view-info-overlay__text"></p>
    </div>
  `;
  app.appendChild(infoOverlay);

  const infoOverlayTitle = infoOverlay.querySelector('.view-info-overlay__title')!;
  const infoOverlayText = infoOverlay.querySelector('.view-info-overlay__text')!;
  const infoOverlayClose = infoOverlay.querySelector('.view-info-overlay__close')!;

  infoOverlay.addEventListener('click', (event) => {
    if (event.target === infoOverlay) {
      infoOverlay.classList.remove('is-visible');
    }
  });

  infoOverlayClose.addEventListener('click', () => {
    infoOverlay.classList.remove('is-visible');
  });

  // Viewport title — shows the current tab name centered at the top of the
  // video area when multiple views are available.
  const viewportTitle = document.createElement('div');

  viewportTitle.className = 'display-chrome__top-center is-hidden';
  displayChrome.appendChild(viewportTitle);

  // Mount the compact top-right telemetry panel (the HUD with live stats).
  const dataPanelHost = document.createElement('div');

  dataPanelHost.className = 'display-chrome__top-right';
  displayChrome.appendChild(dataPanelHost);
  const dataPanel = createTelemetryPanel(dataPanelHost);

  // Mount the decorative center status frame used by tablet/mobile layouts.
  // This is purely cosmetic — it gives the display mode a bit of visual weight
  // when there's no sidebar to fill the screen.
  const centerStatus = document.createElement('div');

  centerStatus.className = 'display-chrome__center-status';
  centerStatus.innerHTML = `
    <div class="display-chrome__center-status-inner">
      <p class="display-chrome__center-kicker">Simulation Active</p>
      <h2 class="display-chrome__center-title">DISPLAY_STATE</h2>
      <div class="display-chrome__center-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  displayChrome.appendChild(centerStatus);

  const initialPlaybackSpeed = loadPlaybackSpeed();

  // Prime the video element with the persisted speed before the first frame.
  viewport.setPlaybackRate(initialPlaybackSpeed);

  // Mount the timeline scrubber footer.
  const timelineHost = document.createElement('div');

  timelineHost.className = 'display-chrome__bottom';
  displayChrome.appendChild(timelineHost);
  const timeline = createTimeline(timelineHost, {
    onChange(position) {
      scheduleViewportSeek(position);
    },
    onTogglePlay: handleTogglePlay,
    onAudioToggle: handleAudioToggle,
    onSpeedChange: handleSpeedChange,
    onSummaryClick: handleShowSummary,
    onScrubStart() {
      handleScrubStart();
      stopScrubberLoop();
    },
    onScrubEnd() {
      void handleScrubEnd();
      if (!viewport.isPaused()) {
        startScrubberLoop();
      }
    },
    initialSpeed: initialPlaybackSpeed,
  });

  // Prime the play/pause button from the current video state.
  timeline.setPlaying(!viewport.isPaused());
  timeline.setAudioVisible(false);
  timeline.setMuted(audioMuted);

  runAudio.addEventListener('loadedmetadata', () => {
    runAudio.playbackRate = viewport.getPlaybackRate();
    syncAudioToViewport({ force: true });
    syncRunAudioPlayback();
  });

  // ── Smooth scrubber updates via requestAnimationFrame ──────────────────
  // The video's native `timeupdate` event fires too infrequently (~4 Hz) to
  // drive the slider smoothly. Instead, we poll the video's current time on
  // every animation frame while playback is active, giving a 60-fps visual.
  let scrubberRafId: number | null = null;
  let pendingSeekFraction: number | null = null;
  let scheduledSeekRafId: number | null = null;
  let isPointerScrubbing = false;
  let wasPlayingBeforeScrub = false;
  let scrubCompletionNonce = 0;
  let skipNextPlayStateAudioSync = false;
  let alternatePrewarmResumeTimer: number | null = null;
  let lastScrubHudUpdateAt = 0;
  let lastAudioSyncAt = Number.NEGATIVE_INFINITY;

  function startScrubberLoop() {
    if (scrubberRafId !== null) return;

    function tick() {
      const fraction = viewport.getPlaybackFraction();

      timeline.setPosition(fraction);

      if (!viewport.isPaused()) {
        scrubberRafId = requestAnimationFrame(tick);
      } else {
        scrubberRafId = null;
      }
    }

    scrubberRafId = requestAnimationFrame(tick);
  }

  function stopScrubberLoop() {
    if (scrubberRafId !== null) {
      cancelAnimationFrame(scrubberRafId);
      scrubberRafId = null;
    }
  }

  function scheduleViewportSeek(fraction: number): void {
    pendingSeekFraction = fraction;

    if (scheduledSeekRafId !== null) {
      return;
    }

    scheduledSeekRafId = requestAnimationFrame(() => {
      scheduledSeekRafId = null;

      if (pendingSeekFraction === null) {
        return;
      }

      const fractionToSeek = pendingSeekFraction;

      pendingSeekFraction = null;
      viewport.seekToFraction(fractionToSeek, { approximate: true });
    });
  }

  function flushScheduledViewportSeek(): void {
    if (pendingSeekFraction === null) {
      return;
    }

    if (scheduledSeekRafId !== null) {
      cancelAnimationFrame(scheduledSeekRafId);
      scheduledSeekRafId = null;
    }

    const fractionToSeek = pendingSeekFraction;

    pendingSeekFraction = null;
    viewport.seekToFraction(fractionToSeek);
  }

  function clearAlternatePrewarmResumeTimer(): void {
    if (alternatePrewarmResumeTimer !== null) {
      window.clearTimeout(alternatePrewarmResumeTimer);
      alternatePrewarmResumeTimer = null;
    }
  }

  function getAlternateViewUrls(): string[] {
    if (!activeRunMatch?.views) {
      return [];
    }

    const selectedViewId = resolveSelectedViewId(activeClass, activeRunMatch);

    return Object.entries(activeRunMatch.views)
      .filter(([viewId]) => viewId !== selectedViewId)
      .map(([, url]) => resolveOnlineAssetUrl(url))
      .filter(Boolean);
  }

  function suspendAlternatePrewarming(): void {
    clearAlternatePrewarmResumeTimer();
    viewport.suspendPrewarming();
  }

  function scheduleAlternatePrewarmingResume(
    delayMs = ALTERNATE_PREWARM_RESUME_DELAY_MS,
  ): void {
    clearAlternatePrewarmResumeTimer();

    if (isPointerScrubbing || viewport.isPaused()) {
      return;
    }

    alternatePrewarmResumeTimer = window.setTimeout(
      () => {
        alternatePrewarmResumeTimer = null;

        if (isPointerScrubbing || viewport.isPaused()) {
          return;
        }

        viewport.resumePrewarming();
        viewport.prewarmSources(getAlternateViewUrls());
      },
      Math.max(0, delayMs),
    );
  }

  function handleScrubStart(): void {
    if (isPointerScrubbing) {
      return;
    }

    scrubCompletionNonce += 1;
    skipNextPlayStateAudioSync = false;
    wasPlayingBeforeScrub = !viewport.isPaused();
    isPointerScrubbing = true;
    lastScrubHudUpdateAt = 0;
    suspendAlternatePrewarming();
    viewport.pause();
    syncRunAudioPlayback();
  }

  async function handleScrubEnd(): Promise<void> {
    if (!isPointerScrubbing) {
      return;
    }

    const completionNonce = ++scrubCompletionNonce;

    isPointerScrubbing = false;
    lastScrubHudUpdateAt = 0;
    flushScheduledViewportSeek();
    await viewport.waitForSeekSettled(SCRUB_SEEK_SETTLE_WAIT_MS);

    if (completionNonce !== scrubCompletionNonce) {
      return;
    }

    syncAudioToViewport({ force: true });
    lastPlaybackSeconds = viewport.getCurrentTimeSeconds();
    refreshLiveDataOverlay(lastPlaybackSeconds);

    if (wasPlayingBeforeScrub) {
      skipNextPlayStateAudioSync = true;
      void playViewportWithMutedFallback(viewport);
    }

    scheduleAlternatePrewarmingResume();
    syncRunAudioPlayback({ forceAudioSync: false });
  }

  // Keep the timeline button in sync and start/stop the smooth scrubber loop.
  viewport.onPlayStateChange((isPaused) => {
    timeline.setPlaying(!isPaused);

    if (isPaused) {
      stopScrubberLoop();
      suspendAlternatePrewarming();
    } else {
      startScrubberLoop();
      scheduleAlternatePrewarmingResume(0);
    }

    if (!isPaused && skipNextPlayStateAudioSync) {
      skipNextPlayStateAudioSync = false;

      return;
    }

    syncRunAudioPlayback();
  });

  // The native `timeupdate` event still drives HUD data refresh — its rate
  // (~4 Hz) is perfectly adequate for live-stat counters and telemetry.
  viewport.onTimeUpdate((position) => {
    lastPlaybackSeconds = position * viewport.getDurationSeconds();

    if (isPointerScrubbing) {
      const now = performance.now();

      if (now - lastScrubHudUpdateAt < SCRUB_HUD_UPDATE_INTERVAL_MS) {
        return;
      }

      lastScrubHudUpdateAt = now;
    }

    refreshLiveDataOverlay(lastPlaybackSeconds);
    if (isPointerScrubbing) {
      return;
    }

    syncAudioToViewport();
  });

  // Mount the shared overlay layer used by the app's mode transitions.
  // Overlays sit above the chrome and block interaction with the viewport.
  const overlayLayer = document.createElement('div');

  overlayLayer.className = 'overlay-layer';
  app.appendChild(overlayLayer);

  // Keep the About modal available for the info button in config/display.
  const aboutModal = createEntryInfoOverlay();

  app.appendChild(aboutModal.infoButton);
  app.appendChild(aboutModal.infoModal);

  // Mount the end-of-run summary overlay that appears when a video finishes.
  const summaryOverlay = createSummaryOverlay(overlayLayer, {
    onReplay: handleReplay,
    onGallery: () => {
      void openGallery({ restoreSummaryOnClose: true });
    },
    onParameters: () => openConfigPanel('parameters'),
    onHome: handleHome,
    showHome: false,
  });

  const galleryOverlay = createGalleryOverlay(overlayLayer, {
    onClose: handleCloseGallery,
    onSelectRun(runId) {
      void handleGalleryRunSelection(runId).catch((error) => {
        logWarn('Gallery run failed to start', {
          simClassId: activeClass.id,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  // When playback ends, remember that state and show the summary overlay.
  viewport.onEnded(() => {
    hasCompletedPlayback = true;
    activeCompletedRunToken += 1;
    updateGalleryProgressForCompletedRun();
    const thumbnail = viewport.captureFrame();

    summaryOverlay.update(
      activeClass,
      getActiveValues(),
      viewport.getDurationSeconds(),
      activeRunMetadata,
      thumbnail,
      activeCompletedRunToken,
    );
    summaryOverlay.show();
    syncRunAudioPlayback();
  });

  // Mount the main selection overlay — parameters, settings, credits, etc.
  const overlayPanel = createOverlayPanel(overlayLayer, {
    simClass: activeClass,
    values: getActiveValues(),
    theme: activeTheme,
    advancedSettings,
    availableScales: SIMULATION_CLASSES,
    onValuesChange: handleValuesChange,
    onThemeChange: handleThemeChange,
    onRun: () => {
      logInfo('Parameters submitted — starting run', {
        simClassId: activeClass.id,
      });
      void handleRun().catch((error) => {
        logWarn('Run failed to start', {
          simClassId: activeClass.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onApplySettings: handleApplySettings,
    onResetGalleryProgress: handleResetGalleryProgress,
    onClose: handleCloseConfig,
    initialView: 'parameters',
  });
  overlayPanel.setBackVisible(!advancedSettings.lockedScaleId);

  // Mount the initializing terminal overlay — the faux-boot sequence.
  const loadingOverlay = createLoadingOverlay(overlayLayer);

  // ── Initial State ────────────────────────────────────────────────────────
  // Prime everything to a clean, empty baseline before the first mode switch.

  timeline.setPosition(0);
  refreshLiveDataOverlay();
  summaryOverlay.hide();

  // ── Collapsible Left-Side UI ────────────────────────────────────────────
  // Each left-side panel shrinks independently when idle. Hover (mouse) or
  // tap (touch) expands only the hovered/tapped element; after 2.5 seconds
  // of inactivity on that element it collapses back.
  const sideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

  const expandOne = (el: HTMLElement) => {
    const timer = sideTimers.get(el);

    if (timer) {
      clearTimeout(timer);
      sideTimers.delete(el);
    }

    el.classList.remove('side-collapsed');
  };

  const scheduleCollapseOne = (el: HTMLElement) => {
    const timer = sideTimers.get(el);

    if (timer) clearTimeout(timer);

    sideTimers.set(
      el,
      setTimeout(() => {
        el.classList.add('side-collapsed');
        sideTimers.delete(el);
      }, COLLAPSIBLE_CHROME_IDLE_MS),
    );
  };

  const collapseOneNow = (el: HTMLElement) => {
    const timer = sideTimers.get(el);

    if (timer) {
      clearTimeout(timer);
      sideTimers.delete(el);
    }

    el.classList.add('side-collapsed');
  };

  const bindCollapsibleChrome = (
    el: HTMLElement,
    options: { toggleOnClick: boolean; isCollapsible?: () => boolean },
  ) => {
    const isCollapsible = options.isCollapsible ?? (() => true);

    // The same behavior powers three different chrome elements, so we make the
    // collapsible-ness itself injectable. That lets entry mode keep the burger
    // permanently expanded without duplicating the rest of the hover/focus logic.
    el.addEventListener('mouseenter', () => expandOne(el));
    el.addEventListener('mouseleave', () => {
      if (!isCollapsible()) {
        expandOne(el);

        return;
      }

      scheduleCollapseOne(el);
    });
    el.addEventListener('focusin', () => expandOne(el));
    el.addEventListener('focusout', (event) => {
      if (!el.contains(event.relatedTarget as Node)) {
        if (!isCollapsible()) {
          expandOne(el);

          return;
        }

        scheduleCollapseOne(el);
      }
    });
    el.addEventListener('click', () => {
      if (!isCollapsible()) {
        expandOne(el);

        return;
      }

      if (el.classList.contains('side-collapsed')) {
        expandOne(el);
        scheduleCollapseOne(el);

        return;
      }

      if (options.toggleOnClick) {
        collapseOneNow(el);
      } else {
        scheduleCollapseOne(el);
      }
    });

    if (isCollapsible()) {
      // Non-entry chrome starts compact so the viewport stays visually quiet
      // until the visitor intentionally interacts with that control.
      collapseOneNow(el);
    } else {
      // Entry mode is the exception: the landing page should advertise the menu
      // rather than hide it behind a shrunk affordance.
      expandOne(el);
    }
  };

  bindCollapsibleChrome(topLeft, {
    toggleOnClick: true,
    isCollapsible: () => app.dataset.mode === 'display',
  });
  bindCollapsibleChrome(leftCenter, { toggleOnClick: true });
  bindCollapsibleChrome(timelineHost, { toggleOnClick: false, isCollapsible: () => false });


  // ── Keyboard controls ──────────────────────────────────────────────────
  let scrubDirection = 0;
  let scrubRaf: number | null = null;
  let scrubFraction = 0;

  const stopScrubbing = () => {
    if (scrubRaf !== null) {
      cancelAnimationFrame(scrubRaf);
      scrubRaf = null;
    }
  };

  const startScrubbing = () => {
    if (scrubRaf !== null) return;
    scrubFraction = viewport.getPlaybackFraction();

    const stepFraction = () => {
      if (scrubDirection === 0) {
        stopScrubbing();

        return;
      }

      const secs = 12 * (1 / 60);
      const frac = secs / Math.max(viewport.getDurationSeconds(), 1);

      scrubFraction = Math.max(0, Math.min(1, scrubFraction + scrubDirection * frac));
      viewport.seekToFraction(scrubFraction, { approximate: true });
      scrubRaf = requestAnimationFrame(stepFraction);
    };

    scrubRaf = requestAnimationFrame(stepFraction);
  };

  document.addEventListener('keydown', (event) => {
    // Only respond during display mode; bail if typing in an input.
    if (app.dataset.mode !== 'display') return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (infoOverlay.classList.contains('is-visible')) {
          infoOverlay.classList.remove('is-visible');
        } else {
          handleHome();
        }

        break;

      case ' ':
        event.preventDefault();
        handleTogglePlay();
        break;

      case 'ArrowLeft':
        event.preventDefault();
        expandOne(timelineHost);
        scrubDirection = -1;
        startScrubbing();
        break;

      case 'ArrowRight':
        event.preventDefault();
        expandOne(timelineHost);
        scrubDirection = 1;
        startScrubbing();
        break;

      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        expandOne(leftCenter);
        scheduleCollapseOne(leftCenter);
        // Only switch views when multiple visualizations are available.
        if (!activeRunMatch?.views || Object.keys(activeRunMatch.views).length <= 1)
          break;

        const configuredViews = activeClass.views.filter(
          (v) => activeRunMatch?.views?.[v.id] !== undefined,
        );

        if (configuredViews.length <= 1) break;

        const currentId =
          activeRunMatch.viewId ?? resolveSelectedViewId(activeClass, activeRunMatch);
        const currentIndex = configuredViews.findIndex((v) => v.id === currentId);
        const nextIndex =
          event.key === 'ArrowUp'
            ? (currentIndex - 1 + configuredViews.length) % configuredViews.length
            : (currentIndex + 1) % configuredViews.length;

        handleViewSelection(configuredViews[nextIndex].id);
        break;
      }
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      scrubDirection = 0;
      stopScrubbing();
    }
  });

  // Start in config mode since there is only one scale.
  viewport.hideMedia();
  viewport.pause();
  setMode('config');

  /**
   * Store updated parameter values for the active simulation family.
   *
   * @param values - New parameter map keyed by parameter id.
   * @returns void
   */
  function handleValuesChange(values: Record<string, number>): void {
    // Take a defensive copy so the caller can't mutate our internal state.
    valuesByClass[activeClass.id] = { ...values };
    logInfo('Parameter values updated', {
      simClassId: activeClass.id,
      values: valuesByClass[activeClass.id],
    });
    // The HUD shows parameter values, so refresh it immediately.
    refreshLiveDataOverlay();
  }

  /**
   * Apply a new theme and keep the overlay picker in sync.
   *
   * @param theme - Theme id to apply.
   * @returns void
   */
  function handleThemeChange(theme: ThemeId): void {
    activeTheme = theme;
    applyTheme(theme);
    overlayPanel.setTheme(theme);
  }

  /**
   * Open the configuration overlay to a specific subview.
   *
   * @param view - Which config subview to display.
   * @returns void
   */
  function openConfigPanel(view: OverlayPanelView): void {
    configReturnView = app.dataset.mode === 'config' ? configActiveView : null;
    galleryOverlay.hide();

    if (view === 'parameters') {
      overlayPanel.setSimulation(activeClass, getActiveValues());
    }

    overlayPanel.setView(view);
    configActiveView = view;
    setMode('config');
  }

  /**
   * Apply settings without launching a new run.
   *
   * @returns void
   */
  function handleApplySettings(nextAdvancedSettings: AdvancedSettings): void {
    applyAdvancedSettings(nextAdvancedSettings);

    // If we've already initialized a run, just go back to display mode.
    if (hasCompletedInitialization) {
      summaryOverlay.hide();
      setMode('display');

      return;
    }

    // Otherwise keep showing the parameter view so the user can start a run.
    overlayPanel.setSimulation(activeClass, getActiveValues());
    overlayPanel.setView('parameters');
    configActiveView = 'parameters';
    configReturnView = null;
  }

  function handleResetGalleryProgress(): void {
    resetGalleryProgress(activeClass.id);

    if (galleryOverlay.isVisible()) {
      galleryOverlay.update(
        activeClass,
        buildGalleryScene(activeClass, activeGalleryRuns),
        new Set(),
      );
    }
  }

  /**
   * Close config to display when possible, otherwise return to entry.
   *
   * @returns void
   */
  function handleCloseConfig(): void {
    galleryOverlay.hide();
    summaryOverlay.hide();
    if (configReturnView) {
      overlayPanel.setView(configReturnView);
      configActiveView = configReturnView;
      configReturnView = null;

      return;
    }

    setMode('display');
  }

  function handleHome(): void {
    logInfo('Returning to parameter selection', { simClassId: activeClass.id });
    galleryOverlay.hide();
    resetSimulationState();
    hasCompletedInitialization = false;
    viewport.hideMedia();
    openConfigPanel('parameters');
  }

  /**
   * Replay the currently loaded simulation video from the beginning.
   *
   * @returns void
   */
  function handleReplay(): void {
    galleryOverlay.hide();
    hasCompletedPlayback = false;
    summaryOverlay.hide();

    const atEnd = viewport.getPlaybackFraction() >= 0.999;

    if (atEnd) {
      viewport.resetPlayback();
      syncAudioToViewport({ force: true });
    }

    void playViewportWithMutedFallback(viewport);
    syncRunAudioPlayback();
  }

  /**
   * Pause playback and show the end-of-run summary overlay on demand.
   *
   * @returns void
   */
  function handleShowSummary(): void {
    hasCompletedPlayback = true;
    activeCompletedRunToken += 1;
    viewport.pause();
    const thumbnail = activeRunMetadata ? viewport.captureFrame() : null;

    summaryOverlay.update(
      activeClass,
      getActiveValues(),
      viewport.getDurationSeconds(),
      activeRunMetadata,
      thumbnail,
      activeCompletedRunToken,
    );
    summaryOverlay.show();
    syncRunAudioPlayback();
  }

  /**
   * Toggle play/pause from the timeline control bar.
   *
   * @returns void
   */
  function handleTogglePlay(): void {
    if (viewport.isPaused()) {
      void playViewportWithMutedFallback(viewport);
    } else {
      viewport.pause();
    }
  }

  function handleAudioToggle(): void {
    audioMuted = !audioMuted;
    syncRunAudioPlayback();
  }

  /**
   * Change the video playback rate and persist the choice.
   *
   * @param rate - New playback rate (0.25, 0.5, or 1).
   * @returns void
   */
  function handleSpeedChange(rate: number): void {
    viewport.setPlaybackRate(rate);
    runAudio.playbackRate = rate;
    persistPlaybackSpeed(rate);
    timeline.setSpeed(rate);
  }

  /**
   * Start a new run for the active simulation class.
   *
   * The flow: find the nearest matching video in the manifest → load its live
   * stats and metadata → start full-fetching the active video AND prewarming
   * alternate views, all behind the terminal boot sequence. During active
   * scrubbing we temporarily suspend that background work, then resume it once
   * playback has settled again.
   *
   * @returns void
   */
  async function handleRun(): Promise<void> {
    const values = getActiveValues();
    const runRequestId = runRequests.start();

    logInfo('Run requested', {
      simClassId: activeClass.id,
      values,
    });

    // Query the manifest for the best-matching precomputed video asset.
    // This only selects which video bundle to show; the user's chosen slider
    // values remain the source of truth for scoring and answer-checking.
    const match = await manifestController.findNearestVideo(
      activeClass.id,
      activeClass.parameters,
      values,
    );

    if (!runRequests.isCurrent(runRequestId)) {
      return;
    }

    trackRunSelection({
      simulationId: activeClass.id,
      parameters: values,
      matchedRunId: match.runId,
    });

    await loadResolvedRunMatch(match, runRequestId);
  }

  async function loadResolvedRunMatch(
    match: VideoMatch,
    runRequestId: number,
  ): Promise<void> {
    galleryOverlay.hide();
    restoreSummaryAfterGalleryClose = false;
    activeGalleryRuns = await manifestController.listRuns(activeClass.id);

    if (!runRequests.isCurrent(runRequestId)) {
      return;
    }

    resetSimulationState({ preserveRunRequest: true });
    activeRunMatch = match;
    // Resolve which view (dark matter, gas density, etc.) to show first.
    const selectedViewId = resolveSelectedViewId(activeClass, match);

    const selectedViewUrl = getViewUrl(match, selectedViewId) ?? match.url;
    const alternateViewUrls = Object.entries(match.views ?? {})
      .filter(([viewId]) => viewId !== selectedViewId)
      .map(([, url]) => url);
    // Fire-and-forget the async data loads — they'll update the HUD when done.
    void loadActiveLiveStats(match.liveDataUrl, runRequestId);
    void loadActiveRunMetadata(match.summaryUrl, runRequestId);
    void loadActiveRunAudio(match.summaryUrl, runRequestId, match.audioUrl);
    viewport.setMuted(true);
    refreshViewSwitcher(selectedViewId);
    refreshAudioControlVisibility();
    setMode('initializing');

    const preparedSourcePromise = prepareActiveVideoSource(selectedViewUrl);

    viewport.resumePrewarming();
    viewport.prewarmSources(alternateViewUrls);

    const videoReady = (async (): Promise<void> => {
      const preparedSource = await preparedSourcePromise;

      if (!runRequests.isCurrent(runRequestId)) {
        return;
      }

      logInfo(
        `Prepared active video source: ${preparedSource.ownedObjectUrl ? 'FULL-FETCH' : 'PROGRESSIVE'}`,
        { selectedViewUrl, waitsForBuffer: preparedSource.shouldWaitForBuffer },
      );

      viewport.setSource(preparedSource.src, {
        ownedObjectUrl: preparedSource.ownedObjectUrl,
      });
      viewport.pause();

      await viewport.waitForLoadedData(ACTIVE_VIDEO_LOADED_DATA_WAIT_MS);

      if (!runRequests.isCurrent(runRequestId)) {
        return;
      }

      if (preparedSource.shouldWaitForBuffer) {
        await viewport.waitForBufferedAhead(
          ACTIVE_VIDEO_BUFFER_SECONDS,
          ACTIVE_VIDEO_BUFFER_WAIT_MS,
        );
      }
    })();

    const loadingFinished = new Promise<void>((resolve) => {
      loadingOverlay.show(getInitializationLines(activeClass), resolve, videoReady, {
        minTerminalTimeMs: getLoadingOverlayMinimumMs(),
      });
    });

    await loadingFinished;

    if (!runRequests.isCurrent(runRequestId)) {
      return;
    }

    hasCompletedInitialization = true;
    viewport.showMedia();
    void playViewportWithMutedFallback(viewport);
    setMode('display');
    syncRunAudioPlayback();
  }

  async function openGallery(options: { restoreSummaryOnClose?: boolean } = {}): Promise<void> {
    restoreSummaryAfterGalleryClose = options.restoreSummaryOnClose ?? false;
    restoreConfigAfterGalleryClose = app.dataset.mode === 'config';
    activeGalleryRuns = await manifestController.listRuns(activeClass.id);

    const scene = buildGalleryScene(activeClass, activeGalleryRuns);
    const litRunIds = new Set(getCompletedGalleryRunIds(activeClass.id));

    overlayPanel.hide();
    galleryOverlay.update(activeClass, scene, litRunIds);
    summaryOverlay.hide();
    galleryOverlay.show();
  }

  function handleCloseGallery(): void {
    galleryOverlay.hide();

    if (restoreConfigAfterGalleryClose) {
      setMode('config');
    } else if (restoreSummaryAfterGalleryClose && hasCompletedPlayback) {
      const thumbnail = viewport.captureFrame();

      summaryOverlay.update(
        activeClass,
        getActiveValues(),
        viewport.getDurationSeconds(),
        activeRunMetadata,
        thumbnail,
        activeCompletedRunToken,
      );
      summaryOverlay.show();
    }

    restoreConfigAfterGalleryClose = false;
    restoreSummaryAfterGalleryClose = false;
  }

  async function handleGalleryRunSelection(runId: string): Promise<void> {
    const run = activeGalleryRuns.find((entry) => entry.runId === runId);

    if (!run) {
      return;
    }

    if (Object.keys(run.parameters).length > 0) {
      valuesByClass[activeClass.id] = { ...run.parameters };
      overlayPanel.setSimulation(activeClass, getActiveValues());
    }

    const runRequestId = runRequests.start();

    logInfo('Gallery run selected', {
      simClassId: activeClass.id,
      runId,
    });

    trackRunSelection({
      simulationId: activeClass.id,
      parameters: getActiveValues(),
      matchedRunId: run.runId,
    });

    await loadResolvedRunMatch(run, runRequestId);
  }

  async function prepareActiveVideoSource(
    videoUrl: string,
  ): Promise<PreparedVideoSource> {
    const resolvedVideoUrl = resolveOnlineAssetUrl(videoUrl);
    const contentLength = await probeContentLength(videoUrl);

    if (
      contentLength !== null &&
      contentLength > 0 &&
      contentLength <= ACTIVE_VIDEO_FULL_FETCH_MAX_BYTES
    ) {
        logInfo('Downloading active video behind loading overlay', {
        videoUrl: resolvedVideoUrl,
        contentLength,
      });

      try {
        const mediaResponse = await fetchWithOnlineAssetFallback(videoUrl);

        if (!mediaResponse.ok) {
          throw new Error(`Failed to download active video: ${resolvedVideoUrl}`);
        }

        const blob = await mediaResponse.blob();

        logInfo(`Active video full fetch complete: ${blob.size} bytes`, {
          videoUrl: resolveOnlineAssetUrl(videoUrl),
          blobType: blob.type,
        });

        return {
          src: URL.createObjectURL(blob),
          ownedObjectUrl: true,
          shouldWaitForBuffer: false,
        };
      } catch (error) {
        logWarn(
          `Full-fetch FAILED; falling back to progressive: ${error instanceof Error ? error.message : String(error)}`,
          {
            videoUrl,
          },
        );
      }
    }

    if (contentLength !== null) {
      logInfo('Active video exceeds full-fetch threshold; using progressive load', {
        videoUrl,
        contentLength,
        fullFetchMaxBytes: ACTIVE_VIDEO_FULL_FETCH_MAX_BYTES,
      });
    } else {
      logInfo('Could not determine active video size; using progressive load', {
        videoUrl,
      });
    }

    logInfo('Using progressive active video load', { videoUrl });

    return {
      src: resolveOnlineAssetUrl(videoUrl),
      ownedObjectUrl: false,
      shouldWaitForBuffer: true,
    };
  }

  async function probeContentLength(videoUrl: string): Promise<number | null> {
    try {
      const rangeResponse = await fetchWithOnlineAssetFallback(videoUrl, {
        headers: { Range: 'bytes=0-0' },
      });

      logInfo('Probed active video size with range request', {
        videoUrl,
        ok: rangeResponse.ok,
        status: rangeResponse.status,
        contentLength: rangeResponse.headers.get('Content-Length'),
        contentRange: rangeResponse.headers.get('Content-Range'),
      });

      const contentLength = parseContentLength(
        rangeResponse.headers.get('Content-Length'),
      );

      if (contentLength !== null) {
        return contentLength;
      }

      const sizeFromRange = parseContentRangeTotal(
        rangeResponse.headers.get('Content-Range'),
      );

      if (sizeFromRange !== null) {
        return sizeFromRange;
      }

      return null;
    } catch (error) {
      logWarn('Could not probe active video size', {
        videoUrl,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  function parseContentRangeTotal(header: string | null): number | null {
    if (!header) {
      return null;
    }

    const match = header.match(/bytes\s+\d+-\d+\/(\d+)/i);

    if (!match) {
      return null;
    }

    const parsed = Number(match[1]);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function parseContentLength(value: string | null): number | null {
    if (!value) {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Switch the shell into one of its four high-level UI modes.
   *
   * Each mode shows/hides the right combination of overlays, chrome chrome, and
   * viewport. The important invariant is that exactly the right set of elements
   * is visible at the end — no more, no less.
   *
   * @param nextMode - Mode to apply.
   * @returns void
   */
  function setMode(nextMode: AppMode): void {
    // Set a data attribute on the app root so CSS can react to mode changes.
    app.dataset.mode = nextMode;

    if (nextMode === 'display') {
      applyTheme(activeTheme);
    }

    // Display chrome is shared between display and config modes.
    const showDisplay = nextMode === 'display' || nextMode === 'config';

    setElementVisibility(displayChrome, showDisplay);
    setElementVisibility(swiftLogo, nextMode === 'display');

    setElementVisibility(
      topLeft,
      nextMode === 'config' || nextMode === 'display',
    );

    if (nextMode !== 'display') {
      expandOne(topLeft);
    } else {
      collapseOneNow(topLeft);
    }

    // Config overlay: only shown when we're explicitly in config mode.
    if (nextMode === 'config') {
      loadingOverlay.hide();
      galleryOverlay.hide();
      overlayPanel.setSimulation(activeClass, getActiveValues());
      overlayPanel.show();
    } else {
      overlayPanel.hide();
    }

    // Summary overlay: hidden outside display mode, but re-shown if playback
    // had already completed when the user left and came back.
    if (nextMode !== 'display') {
      summaryOverlay.hide();
      viewSwitcher.hide();
      viewportTitle.classList.add('is-hidden');
      viewportTitle.innerHTML = '';
    } else if (hasCompletedPlayback) {
      const thumbnail = viewport.captureFrame();

      summaryOverlay.update(
        activeClass,
        getActiveValues(),
        viewport.getDurationSeconds(),
        activeRunMetadata,
        thumbnail,
        activeCompletedRunToken,
      );
      summaryOverlay.show();
    } else {
      refreshViewSwitcher();
    }

    // Viewport visibility: hidden before init and during the boot sequence.
    if (!hasCompletedInitialization || nextMode === 'initializing') {
      viewport.hideMedia();
      if (nextMode === 'initializing') {
        viewport.pause();
      }
    } else {
      viewport.showMedia();
    }

    // Initializing overlay: only shown during the boot sequence.
    if (nextMode !== 'initializing') {
      loadingOverlay.hide();
    }

    updateSynthesizerLogo();
    syncRunAudioPlayback();
  }

  function updateSynthesizerLogo(): void {}

  /**
   * Refresh the compact top-right telemetry card.
   *
   * @param timeSeconds - Current playback time in seconds.
   * @returns void
   */
  function refreshLiveDataOverlay(timeSeconds = 0): void {
    if (!telemetryEnabled) {
      return;
    }

    const sampledValues = sampleLiveStats(
      activeLiveStatsFrames,
      timeSeconds,
      viewport.getDurationSeconds(),
    );
    const videoScaledValues = buildVideoScaledStats(
      activeClass,
      activeRunMetadata,
      timeSeconds,
      viewport.getDurationSeconds(),
    );

    dataPanel.update(activeClass, getActiveValues(), {
      ...sampledValues,
      ...videoScaledValues,
    });
  }

  /**
   * Refresh the display-side video-view switcher.
   *
   * @param selectedId - Optional selected view override.
   * @returns void
   */
  function refreshViewSwitcher(selectedId?: string): void {
    const configuredViews = activeClass.views.filter(
      (view) => activeRunMatch?.views?.[view.id] !== undefined,
    );

    if (configuredViews.length <= 1) {
      viewSwitcher.hide();
      viewportTitle.classList.add('is-hidden');

      return;
    }

    const resolvedId = selectedId ?? resolveSelectedViewId(activeClass, activeRunMatch);
    const activeView = configuredViews.find((v) => v.id === resolvedId);

    viewSwitcher.update(configuredViews, resolvedId);

    if (activeView) {
      viewportTitle.classList.remove('is-hidden');
      viewportTitle.innerHTML = `<span class="viewport-title">${activeView.label ?? activeView.id}</span>`;
    } else {
      viewportTitle.classList.add('is-hidden');
    }
  }

  /**
   * Clear run-specific state so switching families or starting a new run always
   * starts from a clean baseline.
   *
   * @returns void
   */
  function resetSimulationState(options: { preserveRunRequest?: boolean } = {}): void {
    if (!options.preserveRunRequest) {
      runRequests.invalidate();
    }

    activeLiveStatsFrames = EMPTY_LIVE_STATS_DATASET;
    hasCompletedPlayback = false;
    activeRunMetadata = null;
    activeRunMatch = null;
    lastPlaybackSeconds = 0;
    isPointerScrubbing = false;
    wasPlayingBeforeScrub = false;
    scrubCompletionNonce += 1;
    skipNextPlayStateAudioSync = false;
    pendingSeekFraction = null;
    clearAlternatePrewarmResumeTimer();

    if (scheduledSeekRafId !== null) {
      cancelAnimationFrame(scheduledSeekRafId);
      scheduledSeekRafId = null;
    }

    summaryOverlay.hide();
    galleryOverlay.hide();
    viewSwitcher.hide();
    viewportTitle.classList.add('is-hidden');
    viewportTitle.innerHTML = '';
    viewport.pause();
    runAudio.pause();
    viewport.clearPrewarmedSources();
    viewport.resetPlayback();
    timeline.setPosition(0);
    clearActiveRunAudio();
  }

  function updateGalleryProgressForCompletedRun(): void {
    const runId = activeRunMatch?.runId;

    if (!runId) {
      return;
    }

    const knownRunIds = activeGalleryRuns
      .filter((run) => run.simulationId === activeClass.id)
      .map((run) => run.runId);

    if (knownRunIds.length === 0) {
      return;
    }

    const litRunIds = new Set(markGalleryRunCompleted(activeClass.id, runId, knownRunIds));

    if (galleryOverlay.isVisible()) {
      galleryOverlay.update(activeClass, buildGalleryScene(activeClass, activeGalleryRuns), litRunIds);
    }
  }

  /**
   * Switch to a different view for the active run while preserving playback progress.
   *
   * Views are alternate video renderings of the same simulation run (e.g. dark
   * matter vs. gas density). Switching views should feel seamless — we preserve
   * the current seek position and autoplay state.
   *
   * Alternate views are prewarmed in the background and may already have a
   * primed Blob URL by the time the user switches.
   *
   * @param viewId - Manifest/YAML view id.
   * @returns void
   */
  function handleViewSelection(viewId: string): void {
    // Guard: no views configured, or already on this view.
    if (!activeRunMatch?.views) {
      return;
    }

    if (viewId === resolveSelectedViewId(activeClass, activeRunMatch)) {
      return;
    }

    const nextUrl = resolveOnlineAssetUrl(activeRunMatch.views[viewId]);

    if (!nextUrl) {
      return;
    }

    activeRunMatch.viewId = viewId;

    // Determine whether the video was playing before the switch.
    const shouldAutoplay = !viewport.isPaused() && !hasCompletedPlayback;
    // Seek to the same fraction unless playback already finished.
    const seekFraction = hasCompletedPlayback ? 0 : viewport.getPlaybackFraction();

    hasCompletedPlayback = false;
    summaryOverlay.hide();
    viewport.setSource(nextUrl, {
      seekFraction,
      autoplay: shouldAutoplay,
    });

    viewport.prewarmSources(getAlternateViewUrls());

    if (shouldAutoplay && !isPointerScrubbing) {
      scheduleAlternatePrewarmingResume();
    } else {
      suspendAlternatePrewarming();
    }

    refreshViewSwitcher(viewId);
    refreshAudioControlVisibility();
    syncRunAudioPlayback();
    infoOverlay.classList.remove('is-visible');
    updateSynthesizerLogo();
  }

  /**
   * Return a defensive copy of the current parameter state.
   *
   * @returns Parameter map keyed by parameter id.
   */
  function getActiveValues(): Record<string, number> {
    return { ...valuesByClass[activeClass.id] };
  }

  /**
   * Build the initial value map for a simulation family.
   *
   * @param simClass - Simulation family to initialize.
   * @returns Parameter map keyed by parameter id.
   */
  function createRandomizedValues(simClass: SimulationClass): Record<string, number> {
    return Object.fromEntries(
      simClass.parameters.map((parameter) => [
        parameter.id,
        randomizeParameterValue(parameter),
      ]),
    );
  }

  /**
   * Pick a random slider value aligned to the configured parameter step.
   *
   * Rather than always defaulting to min or midpoint, we randomize the initial
   * parameter position so the entry experience feels different each time and
   * users explore more of the parameter space.
   *
   * @param parameter - Parameter schema.
   * @returns Randomized initial value.
   */
  function randomizeParameterValue(
    parameter: SimulationClass['parameters'][number],
  ): number {
    if (parameter.logScale) {
      const logMin = Math.log10(parameter.min);
      const logMax = Math.log10(parameter.max);
      const logValue = logMin + Math.random() * (logMax - logMin);

      return 10 ** logValue;
    }

    // Figure out how many discrete steps the slider has.
    const steps = Math.max(
      0,
      Math.round((parameter.max - parameter.min) / parameter.step),
    );
    // Pick a random step index — uniform across the full range.
    const stepIndex = Math.floor(Math.random() * (steps + 1));
    // Convert back to an actual numeric value.
    const value = parameter.min + stepIndex * parameter.step;
    // Round to the parameter's step precision to avoid floating-point artifacts.
    const decimals = countDecimals(parameter.step);

    return Number(value.toFixed(decimals));
  }

  /**
   * Load the CSV-driven live stats for the active simulation family.
   *
   * @returns Promise that resolves once loading completes.
   */
  async function loadActiveLiveStats(url: string, runRequestId: number): Promise<void> {
    if (!telemetryEnabled) {
      activeLiveStatsFrames = EMPTY_LIVE_STATS_DATASET;

      return;
    }

    let nextFrames = EMPTY_LIVE_STATS_DATASET;

    try {
      nextFrames = await loadLiveStatsCsv(url);
    } catch (error) {
      logWarn('Failed to load live stats', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!runRequests.isCurrent(runRequestId)) {
      return;
    }

    activeLiveStatsFrames = nextFrames;
    refreshLiveDataOverlay();
  }

  /**
   * Load the sidecar run metadata for the active video.
   *
   * @param summaryUrl - URL of the currently selected run summary YAML.
   * @returns Promise that resolves once loading completes.
   */
  async function loadActiveRunMetadata(
    summaryUrl: string,
    runRequestId: number,
  ): Promise<void> {
    const nextMetadata = await loadVideoRunMetadata(summaryUrl);

    if (!runRequests.isCurrent(runRequestId)) {
      return;
    }

    activeRunMetadata = nextMetadata;
    refreshLiveDataOverlay(lastPlaybackSeconds);
  }

  /**
   * Build derived "live" stats that scale a final value linearly with time.
   *
   * For stats flagged with `fromVideo` and `scaleWithTime`, we take the total
   * value from the run's sidecar metadata and linearly interpolate it based on
   * current playback progress. This gives the illusion of a live counter that
   * steadily climbs toward the final total.
   *
   * Example: if a run used 1200 compute units total and we're 50% through,
   * we'd show ~600 units.
   *
   * @param simClass - Active simulation family.
   * @param runMetadata - Parsed run metadata from the active video.
   * @param timeSeconds - Current playback time.
   * @param durationSeconds - Full video duration.
   * @returns Live-value map keyed by stat id.
   */
  function buildVideoScaledStats(
    simClass: SimulationClass,
    runMetadata: VideoRunMetadata | null,
    timeSeconds: number,
    durationSeconds: number,
  ): Record<string, string> {
    // Without metadata or a known duration, there's nothing to scale.
    if (!runMetadata || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return {};
    }

    // Clamp the playback fraction — we don't want >100% values on overshoot.
    const fraction = Math.max(0, Math.min(1, timeSeconds / durationSeconds));
    const output: Record<string, string> = {};

    // Walk the configured live stats and scale any that are marked for it.
    for (const stat of simClass.metadata.liveStats) {
      // Only scale stats that are explicitly tagged for this behavior.
      if (!stat.live || !stat.fromVideo || !stat.scaleWithTime) {
        continue;
      }

      // Look up the final value from the metadata using the configured key.
      const key = stat.videoKey ?? stat.id;
      const rawValue = (runMetadata as unknown as Record<string, unknown>)[key];

      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        continue;
      }

      // Linearly interpolate: fraction × total = current.
      const scaled = rawValue * fraction;

      output[stat.id] = stat.integer ? String(Math.floor(scaled)) : String(scaled);
    }

    return output;
  }

  /**
   * Toggle visibility with both `hidden` and a CSS class.
   *
   * @param element - Element to show/hide.
   * @param isVisible - Whether it should be visible.
   * @returns void
   */
  function setElementVisibility(element: HTMLElement, isVisible: boolean): void {
    element.hidden = !isVisible;
    element.classList.toggle('is-hidden', !isVisible);
  }

  /**
   * Resolve the default view id for the active simulation.
   *
   * Priority order: manifest's default view → the first view in the manifest's
   * views object. This ensures every fresh run starts on the canonical entry
   * view for that simulation family.
   *
   * @param simClass - Simulation family.
   * @param match - Active manifest-backed run.
   * @returns View id when available.
   */
  function resolveSelectedViewId(
    _simClass: SimulationClass,
    match: VideoMatch | null,
  ): string | undefined {
    // No views configured? Just return whatever the match has.
    if (!match?.views) {
      return match?.viewId;
    }

    // Fall back to the manifest's default, or the first view alphabetically.
    return match.viewId ?? Object.keys(match.views)[0];
  }

  /**
   * Resolve one concrete video URL for a matched run and view id.
   *
   * @param match - Active run match.
   * @param viewId - Desired view id.
   * @returns Video URL or `null` when unavailable.
   */
  function getViewUrl(match: VideoMatch, viewId?: string): string | null {
    if (!viewId || !match.views) {
      return null;
    }

    return match.views[viewId] ?? null;
  }

  function doesActiveViewSupportAudio(): boolean {
    const selectedViewId = resolveSelectedViewId(activeClass, activeRunMatch);

    if (!selectedViewId) {
      return false;
    }

    return activeClass.views.some((view) => view.id === selectedViewId && view.audio);
  }

  function getRunAudioUrl(summaryUrl: string, audioUrl?: string): string {
    if (audioUrl) {
      return audioUrl;
    }

    return summaryUrl.replace(/run_summary\.yaml($|\?)/, 'audio_track.wav$1');
  }

  async function loadActiveRunAudio(
    summaryUrl: string,
    runRequestId: number,
    audioUrl?: string,
  ): Promise<void> {
    const resolvedAudioPath = getRunAudioUrl(summaryUrl, audioUrl);
    const resolvedAudioUrl = resolveOnlineAssetUrl(resolvedAudioPath);

    if (knownAvailableAudioUrls.has(resolvedAudioUrl)) {
      activateRunAudio(resolvedAudioUrl);

      return;
    }

    const probeNonce = ++audioProbeNonce;
      const available = await doesAudioTrackExist(resolvedAudioPath);

    if (!runRequests.isCurrent(runRequestId) || probeNonce !== audioProbeNonce) {
      return;
    }

    if (!available) {
      clearActiveRunAudio();

      return;
    }

    knownAvailableAudioUrls.add(resolvedAudioUrl);
    activateRunAudio(resolvedAudioUrl);
  }

  function activateRunAudio(resolvedAudioUrl: string): void {
    activeAudioUrl = resolvedAudioUrl;
    activeAudioAvailable = true;
    runAudio.playbackRate = viewport.getPlaybackRate();

    if (runAudio.src !== activeAudioUrl) {
      runAudio.pause();
      runAudio.src = activeAudioUrl;
      runAudio.load();
    }

    refreshAudioControlVisibility();
    syncRunAudioPlayback();
  }

  async function doesAudioTrackExist(audioUrl: string): Promise<boolean> {
    try {
      const headResponse = await fetchWithOnlineAssetFallback(audioUrl, {
        method: 'HEAD',
      });

      if (headResponse.ok) {
        return true;
      }
    } catch {
      // Fall through to the range request fallback.
    }

    try {
      const rangeResponse = await fetchWithOnlineAssetFallback(audioUrl, {
        headers: { Range: 'bytes=0-0' },
      });

      return rangeResponse.ok;
    } catch {
      return false;
    }
  }

  function clearActiveRunAudio(): void {
    audioProbeNonce += 1;
    activeAudioUrl = null;
    activeAudioAvailable = false;
    runAudio.pause();
    runAudio.removeAttribute('src');
    runAudio.load();
    refreshAudioControlVisibility();
  }

  function resetAudioPreferencesToDefaults(): void {
    audioMuted = advancedSettings.audioMutedByDefault;
    audioVolume = advancedSettings.defaultAudioVolume;
    runAudio.muted = audioMuted;
    runAudio.volume = audioVolume;
    timeline.setMuted(audioMuted);
  }

  function refreshAudioControlVisibility(): void {
    timeline.setAudioVisible(
      doesActiveViewSupportAudio() && activeAudioAvailable && Boolean(activeAudioUrl),
    );
    timeline.setMuted(audioMuted);
  }

  function syncAudioToViewport(
    options: { force?: boolean; driftThresholdSeconds?: number } = {},
  ): void {
    if (!activeAudioAvailable || !Number.isFinite(runAudio.duration) || runAudio.duration <= 0) {
      return;
    }

    const force = options.force ?? false;
    const targetTime = Math.max(
      0,
      Math.min(runAudio.duration, viewport.getCurrentTimeSeconds()),
    );
    const drift = Math.abs(runAudio.currentTime - targetTime);

    if (!force && drift <= (options.driftThresholdSeconds ?? AUDIO_RESYNC_DRIFT_SECONDS)) {
      return;
    }

    const now = performance.now();

    if (!force && now - lastAudioSyncAt < AUDIO_RESYNC_COOLDOWN_MS) {
      return;
    }

    runAudio.currentTime = targetTime;
    lastAudioSyncAt = now;
  }

  function syncRunAudioPlayback(
    options: { forceAudioSync?: boolean } = {},
  ): void {
    const audioVisible =
      doesActiveViewSupportAudio() && activeAudioAvailable && Boolean(activeAudioUrl);

    refreshAudioControlVisibility();
    runAudio.muted = audioMuted;
    runAudio.volume = audioVolume;
    runAudio.playbackRate = viewport.getPlaybackRate();

    if (!audioVisible) {
      runAudio.pause();

      return;
    }

    syncAudioToViewport({ force: options.forceAudioSync ?? runAudio.paused });

    if (
      app.dataset.mode !== 'display' ||
      viewport.isPaused() ||
      hasCompletedPlayback ||
      isPointerScrubbing
    ) {
      runAudio.pause();

      return;
    }

    void runAudio.play().catch(() => {
      audioMuted = true;
      runAudio.muted = true;
      timeline.setMuted(true);
    });
  }

  function getSelectableSimulationClasses(
    settings: AdvancedSettings,
  ): SimulationClass[] {
    const visibleScaleIds = new Set(getVisibleScaleIds(settings, scaleIds));

    return SIMULATION_CLASSES.filter((simClass) => visibleScaleIds.has(simClass.id));
  }

  function getSimulationClassById(simClassId: string | null): SimulationClass | null {
    if (!simClassId) {
      return null;
    }

    return SIMULATION_CLASSES.find((simClass) => simClass.id === simClassId) ?? null;
  }

  function getLoadingOverlayMinimumMs(): number {
    if (manifestController.getSource() !== 'local') {
      return INITIALIZATION.MIN_TERMINAL_TIME_MS;
    }

    return randomIntInclusive(
      INITIALIZATION.MIN_TERMINAL_TIME_MS,
      LOCAL_MANIFEST_MIN_TERMINAL_TIME_MAX_MS,
    );
  }

  function randomIntInclusive(min: number, max: number): number {
    const lower = Math.ceil(Math.min(min, max));
    const upper = Math.floor(Math.max(min, max));

    return Math.floor(Math.random() * (upper - lower + 1)) + lower;
  }

  function applyAdvancedSettings(nextAdvancedSettings: AdvancedSettings): void {
    advancedSettings = saveAdvancedSettings(nextAdvancedSettings, scaleIds);
    setVerboseLoggingEnabled(advancedSettings.verboseLogging);
    availableSimulationClasses = getSelectableSimulationClasses(advancedSettings);

    displayMenu.setFullscreenVisible(!advancedSettings.lockFullscreen);
    overlayPanel.setAdvancedSettings(advancedSettings);
    logInfo('Advanced settings updated', advancedSettings);
    resetAudioPreferencesToDefaults();
    syncRunAudioPlayback();
  }
}
