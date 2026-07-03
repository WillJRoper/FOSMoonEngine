/**
 * Credits loaded from YAML.
 *
 * Credits are displayed from the display-mode burger menu (in the config overlay
 * under the "Credits" view). Keeping this list in YAML makes it easy to add or
 * update attribution text without touching code — anyone on the team can edit
 * the YAML file directly.
 */

import { parse } from 'yaml';
import creditsRaw from './credits.yaml?raw';

export interface CreditEntry {
  /** Exact text that must appear in the credits. */
  text: string;
  /** Optional URL that makes the credit entry a clickable link. */
  url?: string;
  /** Optional path to a logo image (relative to public/). */
  logo?: string;
  /** When true this entry is rendered as a section heading, not a regular entry. */
  header?: boolean;
}

/**
 * Credits list shown in the Credits view.
 *
 * We validate every entry at runtime because YAML files are data — they can
 * contain anything. Invalid entries are silently skipped so a malformed credit
 * never crashes the UI.
 *
 * @returns Array of credit entries (empty array when none are valid).
 */
export function getCredits(): CreditEntry[] {
  const parsed = parse(creditsRaw) as unknown;

  // If the YAML doesn't contain an array, there's nothing to show.
  if (!Array.isArray(parsed)) {
    return [];
  }

  const credits: CreditEntry[] = [];

  for (const entry of parsed) {
    // Skip anything that isn't an object (scalars, nulls, arrays).
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    // Extract and validate the `text` field — it must be a non-empty string.
    const text = (entry as { text?: unknown }).text;

    if (typeof text !== 'string' || text.trim().length === 0) {
      continue;
    }

    const credit: CreditEntry = { text };

    // Optional URL that turns the credit line into a clickable link.
    const url = (entry as { url?: unknown }).url;

    if (typeof url === 'string' && url.trim().length > 0) {
      credit.url = url;
    }

    // Optional logo path displayed inline before the text.
    const logo = (entry as { logo?: unknown }).logo;

    if (typeof logo === 'string' && logo.trim().length > 0) {
      credit.logo = logo;
    }

    // When true the entry is rendered as a section heading.
    const header = (entry as { header?: unknown }).header;

    if (header === true) {
      credit.header = true;
    }

    credits.push(credit);
  }

  return credits;
}
