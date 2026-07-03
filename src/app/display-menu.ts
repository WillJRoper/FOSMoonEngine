/**
 * Display-mode burger menu.
 *
 * This module isolates the menu DOM so `main.ts` does not need to own the full
 * markup, click handling, and open/close behavior itself. The menu remains a
 * simple DOM builder rather than a framework-style component.
 */

export interface DisplayMenuController {
  /** Close the menu popover if it is open. */
  close: () => void;
	/** Update whether the Home or New Simulation action should be shown. */
  setHomeVisible: (isVisible: boolean) => void;
  /** Hide or show the Fullscreen toggle. */
  setFullscreenVisible: (isVisible: boolean) => void;
}

interface DisplayMenuOptions {
  /** Called after the user chooses to jump back to parameter selection. */
  onParameters: () => void;
  /** Called after the user picks a non-simulation view entry. */
  onViewSelected: (view: 'settings' | 'credits' | 'gallery') => void;
  /** Whether the Home action should be visible. */
  showHome?: boolean;
}

/**
 * Build the burger-menu button and dropdown.
 *
 * The helper mounts everything into the supplied host element and wires all
 * event listeners needed for menu toggling and outside-click dismissal.
 *
 * @param host - DOM node that owns the menu button + popover.
 * @param simulationClasses - List of simulation families to render.
 * @param options - Callback hooks for selections.
 * @returns Controller for imperative close.
 */
export function createDisplayMenu(
  host: HTMLElement,
  options: DisplayMenuOptions,
): DisplayMenuController {
  // Three stacked spans → the classic hamburger icon. CSS handles the styling.
  const trigger = document.createElement('button');

  trigger.className = 'display-button';
  trigger.type = 'button';
  trigger.innerHTML = '<span></span><span></span><span></span>';
  trigger.setAttribute('aria-label', 'Open configuration overlay');
  host.appendChild(trigger);

  // The dropdown itself is intentionally plain: a static vertical list of
  // actions with one header row and a shared button renderer.
  const menu = document.createElement('div');

  menu.className = 'display-menu';

  const header = document.createElement('div');

  header.className = 'display-menu__header';
  header.textContent = 'Menu';
  menu.appendChild(header);

	const parametersButton = createMenuButton('New Simulation', () => {
    close();
    options.onParameters();
  });

  menu.appendChild(parametersButton);

  menu.appendChild(
    createMenuButton('Gallery', () => {
      close();
      options.onViewSelected('gallery');
    }),
  );

  menu.appendChild(
    createMenuButton('Settings', () => {
      close();
      options.onViewSelected('settings');
    }),
  );

  menu.appendChild(
    createMenuButton('Credits', () => {
      close();
      options.onViewSelected('credits');
    }),
  );

  const fullscreenButton = createMenuButton('Fullscreen', () => {
    close();
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.getElementById('app')?.requestFullscreen();
    }
  });

  fullscreenButton.classList.add('display-menu__fullscreen');

  menu.appendChild(fullscreenButton);

  host.appendChild(menu);

  function updateFullscreenLabel() {
    const label = fullscreenButton.querySelector('.display-menu__item-label');

    if (label) {
      label.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
    }

    const app = document.getElementById('app');

    if (app) {
      app.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
    }
  }

  document.addEventListener('fullscreenchange', updateFullscreenLabel);

  // Toggle the popover from the burger button.
  trigger.addEventListener('click', () => {
    host.classList.toggle('open');
  });

  // Global outside-click dismissal keeps the menu behaving like a popover even
  // though it is built from plain DOM rather than a dedicated UI library.
  document.addEventListener('click', (event) => {
    if (!host.contains(event.target as Node)) {
      close();
    }
  });

  return {
    close,
    setHomeVisible(_isVisible: boolean) {},
    setFullscreenVisible(isVisible) {
      fullscreenButton.hidden = !isVisible;
      fullscreenButton.classList.toggle('is-hidden', !isVisible);
    },
  };

  /**
   * Build one menu row with the shared marker + label styling.
   *
   * @param label - Visible label text.
   * @param onClick - Called on button click.
   * @returns The created button element.
   */
  function createMenuButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');

    button.className = 'display-menu__item';
    button.type = 'button';
    button.innerHTML = `
      <span class="display-menu__item-mark"></span>
      <span class="display-menu__item-label">${label}</span>
    `;
    button.addEventListener('click', onClick);

    return button;
  }

  /**
   * Collapse the popover by removing the host's `open` class.
   *
   * @returns void
   */
  function close() {
    host.classList.remove('open');
  }

}
