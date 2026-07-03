const LOG_PREFIX = '[MoonEngine]';
let verboseLoggingEnabled = false;

export function setVerboseLoggingEnabled(enabled: boolean): void {
  verboseLoggingEnabled = enabled;
}

export function isVerboseLoggingEnabled(): boolean {
  return verboseLoggingEnabled;
}

export function logInfo(message: string, payload?: unknown): void {
  if (!isVerboseLoggingEnabled()) {
    return;
  }

  console.info(LOG_PREFIX, message, payload ?? '');
}

export function logWarn(message: string, payload?: unknown): void {
  if (!isVerboseLoggingEnabled()) {
    return;
  }

  console.warn(LOG_PREFIX, message, payload ?? '');
}

export function logError(message: string, payload?: unknown): void {
  console.error(LOG_PREFIX, message, payload ?? '');
}
