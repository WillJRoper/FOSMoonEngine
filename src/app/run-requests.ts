export interface RunRequestController {
  start: () => number;
  invalidate: () => void;
  isCurrent: (requestId: number) => boolean;
}

export function createRunRequestController(): RunRequestController {
  let activeRequestId = 0;

  return {
    start() {
      activeRequestId += 1;

      return activeRequestId;
    },
    invalidate() {
      activeRequestId += 1;
    },
    isCurrent(requestId) {
      return requestId === activeRequestId;
    },
  };
}
