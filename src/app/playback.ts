import type { ViewportController } from '../video_player/viewport.ts';

const PLAYBACK_SPEED_KEY = 'moon-engine-playback-speed';
const VALID_PLAYBACK_RATES = new Set([0.25, 0.5, 1, 2]);

export function loadPlaybackSpeed(): number {
  const raw = localStorage.getItem(PLAYBACK_SPEED_KEY);
  const parsed = raw ? Number(raw) : NaN;

  return VALID_PLAYBACK_RATES.has(parsed) ? parsed : 1;
}

export function persistPlaybackSpeed(rate: number): void {
  localStorage.setItem(PLAYBACK_SPEED_KEY, String(rate));
}

export async function playViewportWithMutedFallback(
  viewport: Pick<ViewportController, 'play' | 'setMuted'>,
): Promise<void> {
  try {
    await viewport.play();
  } catch {
    viewport.setMuted(true);

    try {
      await viewport.play();
    } catch {
      // Some browsers still reject playback without a direct gesture.
    }
  }
}
