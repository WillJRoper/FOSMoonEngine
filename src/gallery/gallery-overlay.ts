/**
 * Gallery overlay.
 *
 * Renders a zoomable, pannable field of hexagonal run nodes. The nodes are
 * regular buttons so click, focus, and keyboard behavior stay simple while the
 * thumbnail art is clipped into a hex silhouette with CSS.
 */

import type { SimulationClass } from '../selection/simulation-catalog.ts';
import type { GalleryScene } from './gallery-data.ts';

const MAX_SCALE = 2.2;
const INITIAL_SCALE = 0.88;
const VIEWPORT_PADDING = 48;
const CLICK_DRAG_THRESHOLD_PX = 8;
const WHEEL_ZOOM_IN_FACTOR = 1.05;
const WHEEL_ZOOM_OUT_FACTOR = 0.96;
const NODE_REVEAL_STAGGER_MS = 16;

interface PointerSample {
  x: number;
  y: number;
}

export interface GalleryOverlayController {
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
  update: (
    simClass: SimulationClass,
    scene: GalleryScene,
    litRunIds: Set<string>,
  ) => void;
}

interface GalleryOverlayOptions {
  onClose: () => void;
  onSelectRun: (runId: string) => void;
}

export function createGalleryOverlay(
  container: HTMLElement,
  options: GalleryOverlayOptions,
): GalleryOverlayController {
  const overlay = document.createElement('section');

  overlay.className = 'overlay overlay--gallery';
  overlay.hidden = true;
  overlay.classList.add('is-hidden');
  overlay.tabIndex = -1;

  const panel = document.createElement('div');

  panel.className = 'gallery-overlay';

  const header = document.createElement('div');

  header.className = 'gallery-overlay__header';
  header.innerHTML = `
    <div>
      <h2 class="gallery-overlay__title">Impact Gallery</h2>
    </div>
    <button class="gallery-overlay__close" type="button" aria-label="Close Gallery">&times;</button>
  `;

  const viewport = document.createElement('div');

  viewport.className = 'gallery-overlay__viewport';

  const stage = document.createElement('div');

  stage.className = 'gallery-overlay__stage';
  viewport.appendChild(stage);

  const empty = document.createElement('div');

  empty.className = 'gallery-overlay__empty is-hidden';
  empty.innerHTML = `
    <p class="gallery-overlay__empty-title">No runs in the gallery yet</p>
    <p class="gallery-overlay__empty-copy">Once manifest-backed runs are available for this simulation family, they will appear here automatically.</p>
  `;

  panel.appendChild(header);
  panel.appendChild(viewport);
  panel.appendChild(empty);
  overlay.appendChild(panel);
  container.appendChild(overlay);

  const closeButton = header.querySelector(
    '.gallery-overlay__close',
  ) as HTMLButtonElement;

  let currentScene: GalleryScene = { nodes: [], stageWidth: 0, stageHeight: 0 };
  let currentLitRunIds = new Set<string>();
  let scale = INITIAL_SCALE;
  let translateX = 0;
  let translateY = 0;
  let isPointerDragging = false;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let dragStartTranslateX = 0;
  let dragStartTranslateY = 0;
  let dragDistancePx = 0;
  let pressedRunId: string | null = null;
  let pinchStartDistance = 0;
  let pinchStartScale = INITIAL_SCALE;
  let pinchStartWorldX = 0;
  let pinchStartWorldY = 0;
  let renderVersion = 0;
  let hasPlayedInitialReveal = false;
  const activePointers = new Map<number, PointerSample>();

  closeButton.addEventListener('click', () => options.onClose());

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      options.onClose();
    }
  });

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      options.onClose();
    }
  });

  viewport.addEventListener('pointerdown', (event) => {
    pressedRunId =
      (event.target as HTMLElement).closest<HTMLElement>('.gallery-overlay__node')
        ?.dataset.runId ?? null;
    activePointers.set(event.pointerId, getViewportPoint(event));
    viewport.setPointerCapture(event.pointerId);

    if (activePointers.size >= 2) {
      isPointerDragging = false;
      viewport.classList.remove('is-dragging');
      beginPinchZoom();

      return;
    }

    isPointerDragging = true;
    dragOriginX = event.clientX;
    dragOriginY = event.clientY;
    dragStartTranslateX = translateX;
    dragStartTranslateY = translateY;
    dragDistancePx = 0;
    viewport.classList.add('is-dragging');
  });

  viewport.addEventListener('pointermove', (event) => {
    if (activePointers.has(event.pointerId)) {
      activePointers.set(event.pointerId, getViewportPoint(event));
    }

    if (activePointers.size >= 2) {
      updatePinchZoom();

      return;
    }

    if (!isPointerDragging) {
      return;
    }

    dragDistancePx = Math.max(
      dragDistancePx,
      Math.hypot(event.clientX - dragOriginX, event.clientY - dragOriginY),
    );
    translateX = dragStartTranslateX + (event.clientX - dragOriginX);
    translateY = dragStartTranslateY + (event.clientY - dragOriginY);
    clampTranslation();
    applyTransform();
  });

  viewport.addEventListener('pointerup', (event) => {
    if (
      activePointers.size === 1 &&
      pressedRunId &&
      dragDistancePx <= CLICK_DRAG_THRESHOLD_PX
    ) {
      options.onSelectRun(pressedRunId);
    }

    releasePointer(event.pointerId);
  });

  viewport.addEventListener('pointercancel', (event) => {
    releasePointer(event.pointerId);
  });

  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();

      const zoomFactor = event.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
      zoomAroundViewportPoint(
        getViewportPoint(event),
        clampScale(scale * zoomFactor, getMinimumScale()),
      );
    },
    { passive: false },
  );

  window.addEventListener('resize', () => {
    if (overlay.hidden) {
      return;
    }

    scale = clampScale(scale, getMinimumScale());
    clampTranslation();
    applyTransform();
  });

  return {
    show() {
      overlay.hidden = false;
      overlay.classList.remove('is-hidden');
      requestAnimationFrame(() => {
        if (!overlay.hidden) {
          resetView();
        }
      });
      overlay.focus();
    },
    hide() {
      stopDragging();
      overlay.hidden = true;
      overlay.classList.add('is-hidden');
    },
    isVisible() {
      return !overlay.hidden;
    },
    update(_simClass, scene, litRunIds) {
      currentScene = scene;
      currentLitRunIds = new Set(litRunIds);
      stage.style.width = `${scene.stageWidth}px`;
      stage.style.height = `${scene.stageHeight}px`;
      empty.classList.toggle('is-hidden', scene.nodes.length > 0);
      viewport.classList.toggle('is-hidden', scene.nodes.length === 0);
      renderNodes();

      if (!overlay.hidden) {
        requestAnimationFrame(() => {
          if (!overlay.hidden) {
            resetView();
          }
        });
      }
    },
  };

  function renderNodes(): void {
    const nextRenderVersion = renderVersion + 1;
    const shouldAnimateReveal = !hasPlayedInitialReveal;

    renderVersion = nextRenderVersion;
    stage.innerHTML = '';

    if (currentScene.nodes.length === 0) {
      return;
    }

    const buttons: Array<{ element: HTMLButtonElement; revealOrder: number }> = [];
    const imageLoads: Array<Promise<void>> = [];

    for (const node of currentScene.nodes) {
      const button = document.createElement('button');
      const media = document.createElement('div');
      const image = document.createElement('img');

      button.className = 'gallery-overlay__node';
      button.type = 'button';
      button.style.left = `${node.x}px`;
      button.style.top = `${node.y}px`;
      button.style.width = `${node.width}px`;
      button.style.height = `${node.height}px`;
      button.dataset.runId = node.runId;
      button.classList.toggle('is-pending', shouldAnimateReveal);
      button.classList.toggle('is-lit', currentLitRunIds.has(node.runId));
      button.setAttribute(
        'aria-label',
        `Open gallery run ${stage.childElementCount + 1}`,
      );

      media.className = 'gallery-overlay__node-media';

      image.className = 'gallery-overlay__node-image';
      image.src = node.thumbnailUrl;
      image.alt = '';
      image.decoding = 'async';
      image.draggable = false;
      imageLoads.push(waitForImage(image));

      media.appendChild(image);
      button.appendChild(media);
      stage.appendChild(button);
      buttons.push({ element: button, revealOrder: node.revealOrder });
    }

    if (!shouldAnimateReveal) {
      return;
    }

    void Promise.allSettled(imageLoads).then(() => {
      if (renderVersion !== nextRenderVersion) {
        return;
      }

      hasPlayedInitialReveal = true;

      for (const { element, revealOrder } of buttons) {
        window.setTimeout(() => {
          if (renderVersion !== nextRenderVersion || !element.isConnected) {
            return;
          }

          element.classList.add('is-visible');
        }, revealOrder * NODE_REVEAL_STAGGER_MS);
      }
    });
  }

  function waitForImage(image: HTMLImageElement): Promise<void> {
    if (image.complete) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => {
        image.removeEventListener('load', finish);
        image.removeEventListener('error', finish);
        resolve();
      };

      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', finish, { once: true });
    });
  }

  function resetView(): void {
    scale = getDefaultScale();
    translateX = getCenteredTranslateX();
    translateY = getCenteredTranslateY();
    clampTranslation();
    applyTransform();
  }

  function applyTransform(): void {
    stage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function clampTranslation(): void {
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const scaledWidth = currentScene.stageWidth * scale;
    const scaledHeight = currentScene.stageHeight * scale;
    const centeredX = getCenteredTranslateX();
    const centeredY = getCenteredTranslateY();
    const maxOffsetX = Math.max(120, (scaledWidth - viewportWidth) / 2 + 120);
    const maxOffsetY = Math.max(120, (scaledHeight - viewportHeight) / 2 + 120);

    translateX = clamp(translateX, centeredX - maxOffsetX, centeredX + maxOffsetX);
    translateY = clamp(translateY, centeredY - maxOffsetY, centeredY + maxOffsetY);
  }

  function stopDragging(): void {
    isPointerDragging = false;
    dragDistancePx = 0;
    pressedRunId = null;
    activePointers.clear();
    viewport.classList.remove('is-dragging');
  }

  function beginPinchZoom(): void {
    const [first, second] = getFirstTwoPointers();

    if (!first || !second) {
      return;
    }

    pinchStartDistance = getPointerDistance(first, second);
    pinchStartScale = scale;
    const midpoint = getPointerMidpoint(first, second);
    const worldPoint = viewportPointToWorld(midpoint);

    pinchStartWorldX = worldPoint.x;
    pinchStartWorldY = worldPoint.y;
  }

  function updatePinchZoom(): void {
    const [first, second] = getFirstTwoPointers();

    if (!first || !second || pinchStartDistance <= 0) {
      return;
    }

    const midpoint = getPointerMidpoint(first, second);
    const distance = getPointerDistance(first, second);
    const nextScale = clampScale(
      pinchStartScale * (distance / Math.max(pinchStartDistance, 1e-6)),
      getMinimumScale(),
    );

    scale = nextScale;
    translateX = midpoint.x - pinchStartWorldX * scale;
    translateY = midpoint.y - pinchStartWorldY * scale;
    clampTranslation();
    applyTransform();
  }

  function releasePointer(pointerId: number): void {
    activePointers.delete(pointerId);
    pressedRunId = null;

    if (viewport.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }

    if (activePointers.size >= 2) {
      beginPinchZoom();

      return;
    }

    stopDragging();

    if (activePointers.size === 1) {
      const remainingPointer = Array.from(activePointers.values())[0];

      dragOriginX = remainingPointer.x;
      dragOriginY = remainingPointer.y;
      dragStartTranslateX = translateX;
      dragStartTranslateY = translateY;
      dragDistancePx = 0;
    }
  }

  function zoomAroundViewportPoint(point: PointerSample, nextScale: number): void {
    const worldPoint = viewportPointToWorld(point);

    scale = nextScale;
    translateX = point.x - worldPoint.x * scale;
    translateY = point.y - worldPoint.y * scale;
    clampTranslation();
    applyTransform();
  }

  function viewportPointToWorld(point: PointerSample): { x: number; y: number } {
    return {
      x: (point.x - translateX) / Math.max(scale, 1e-6),
      y: (point.y - translateY) / Math.max(scale, 1e-6),
    };
  }

  function getViewportPoint(
    event: MouseEvent | PointerEvent | WheelEvent,
  ): PointerSample {
    const rect = viewport.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function getFirstTwoPointers(): [
    PointerSample | undefined,
    PointerSample | undefined,
  ] {
    const pointers = Array.from(activePointers.values());

    return [pointers[0], pointers[1]];
  }

  function getPointerMidpoint(
    first: PointerSample,
    second: PointerSample,
  ): PointerSample {
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }

  function getPointerDistance(first: PointerSample, second: PointerSample): number {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function getDefaultScale(): number {
    return getMinimumScale();
  }

  function getMinimumScale(): number {
    if (currentScene.stageWidth <= 0 || currentScene.stageHeight <= 0) {
      return INITIAL_SCALE;
    }

    const availableWidth = Math.max(1, viewport.clientWidth - VIEWPORT_PADDING * 2);
    const availableHeight = Math.max(1, viewport.clientHeight - VIEWPORT_PADDING * 2);
    const fitWidth = availableWidth / currentScene.stageWidth;
    const fitHeight = availableHeight / currentScene.stageHeight;

    return Math.min(MAX_SCALE, Math.max(0.1, Math.min(fitWidth, fitHeight)));
  }

  function getCenteredTranslateX(): number {
    return (viewport.clientWidth - currentScene.stageWidth * scale) / 2;
  }

  function getCenteredTranslateY(): number {
    return (viewport.clientHeight - currentScene.stageHeight * scale) / 2;
  }
}

function clampScale(value: number, minScale: number): number {
  return clamp(value, minScale, MAX_SCALE);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
