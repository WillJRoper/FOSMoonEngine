/**
 * Theme model, persistence, and picker UI.
 *
 * Defines supported themes, persists the active choice to localStorage, and
 * applies it to the document root via `data-theme`. CSS tokens live in
 * `src/style.css`.
 */

const STORAGE_KEY = 'moon-engine-theme';

export type ThemeId = 'glass' | 'matrix' | 'hal' | 'nostromo' | 'tron';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  icon: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'glass', label: 'Glass', icon: '[ ]' },
  { id: 'matrix', label: 'Matrix', icon: '[#]' },
  { id: 'hal', label: 'HAL 9000', icon: '( )' },
  { id: 'nostromo', label: 'Nostromo', icon: '[=]' },
  { id: 'tron', label: 'Tron', icon: '<>' },
];

export interface ThemePickerController {
  /** Update which theme button is visually marked active. */
  setActive: (id: ThemeId) => void;
}

/**
 * Read the last persisted theme.
 *
 * @returns The saved theme id, or a reasonable default when missing/invalid.
 */
export function getInitialTheme(): ThemeId {
  // We validate the stored string against the known theme ids so stale or
  // hand-edited localStorage values do not put the UI into an invalid state.
  const saved = localStorage.getItem(STORAGE_KEY);

  return isThemeId(saved) ? saved : 'glass';
}

/**
 * Apply a theme to the document and persist the choice.
 *
 * @param id - Theme id to activate.
 * @returns void
 */
export function applyTheme(id: ThemeId): void {
  // `data-theme` lets CSS own the real visual differences; TypeScript just picks
  // the active token set and persists the choice for the next visit.
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem(STORAGE_KEY, id);
}

/**
 * Render the theme picker UI.
 *
 * @param container - Host element to mount into.
 * @param initialTheme - Theme id to show as initially active.
 * @param onChange - Callback invoked after a user picks a theme.
 * @returns A controller that can update active styling without rebuilding.
 */
export function createThemePicker(
  container: HTMLElement,
  initialTheme: ThemeId,
  onChange: (theme: ThemeId) => void,
): ThemePickerController {
  // The picker is intentionally tiny: one button per known theme.
  const root = document.createElement('div');

  root.className = 'theme-picker';

  const buttons = new Map<ThemeId, HTMLButtonElement>();

  for (const theme of THEMES) {
    // Keep a direct button map so `setActive()` can update state without
    // rebuilding the picker every time the shell applies a theme.
    const button = document.createElement('button');

    button.className = 'theme-picker__option';
    button.type = 'button';
    button.innerHTML = `
      <span class="theme-picker__icon">${theme.icon}</span>
      <span class="theme-picker__label">${theme.label}</span>
    `;
    button.addEventListener('click', () => {
      setActive(theme.id);
      onChange(theme.id);
    });
    root.appendChild(button);
    buttons.set(theme.id, button);
  }

  container.appendChild(root);
  setActive(initialTheme);

  function setActive(id: ThemeId) {
    // One pass flips all active states so there is never ambiguity about which
    // theme is currently selected.
    for (const [themeId, button] of buttons.entries()) {
      const isActive = themeId === id;

      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  return { setActive };
}

function isThemeId(value: string | null): value is ThemeId {
  // Shared runtime guard used by localStorage recovery.
  return THEMES.some((theme) => theme.id === value);
}
