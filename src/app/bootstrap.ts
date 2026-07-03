/**
 * Application bootstrap.
 *
 * This module is intentionally tiny: it finds the HTML mount node, validates
 * that it exists, and then hands off to the real app shell builder. Keeping
 * the bootstrap separate from the shell means we can test the shell directly
 * without needing a DOM element with id="app".
 */

import { createAppShell } from './app-shell.ts';

/**
 * Locate the root DOM node and start the application.
 *
 * The mount node is `<div id="app">` in `index.html`. If it's missing — which
 * should never happen in normal operation — we throw early with a clear error
 * rather than failing silently later.
 *
 * @returns void
 */
export function bootstrapApp(): void {
  const mountNode = document.getElementById('app');

  if (!mountNode) {
    throw new Error('App mount element not found.');
  }

  createAppShell(mountNode);
}
