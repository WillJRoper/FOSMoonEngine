import { TRACKING_API_URL } from './constants.ts';
import { logInfo, logWarn } from './logger.ts';

interface TrackRunPayload {
  simulationId: string;
  parameters: Record<string, number>;
  matchedRunId?: string;
}

export function trackRunSelection(payload: TrackRunPayload): void {
  if (!TRACKING_API_URL) {
    return;
  }

  sendTrackingRequest(TRACKING_API_URL, payload);
}

function sendTrackingRequest(url: string, payload: TrackRunPayload): void {
  if (navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const sent = navigator.sendBeacon(url, blob);

    if (sent) {
      logInfo('Run selection tracking dispatched', {
        simulationId: payload.simulationId,
      });

      return;
    }
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  })
    .then((response) => {
      if (response.ok) {
        logInfo('Run selection tracked', { simulationId: payload.simulationId });
      } else {
        logWarn('Run selection tracking rejected', {
          simulationId: payload.simulationId,
          status: response.status,
        });
      }
    })
    .catch((error) => {
      logWarn('Run selection tracking failed', {
        simulationId: payload.simulationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
