/**
 * Display-mode simulation view switcher.
 *
 * Renders a compact row of buttons that lets the user swap between multiple
 * video views for the currently selected run.
 */

import type { SimulationViewOption } from '../selection/simulation-catalog.ts';

export interface ViewSwitcherController {
  /** Replace the available view buttons and active selection. */
  update: (options: SimulationViewOption[], selectedId?: string) => void;

  /** Clear and hide the switcher. */
  hide: () => void;
}

interface ViewSwitcherOptions {
  onSelect: (viewId: string) => void;
  onInfo: (viewId: string, label: string, description: string) => void;
}

/**
 * Create the display-side view switcher.
 *
 * @param container - Host element to mount into.
 * @param options - Selection callback hooks.
 * @returns Controller for updating the switcher state.
 */
export function createViewSwitcher(
  container: HTMLElement,
  options: ViewSwitcherOptions,
): ViewSwitcherController {
  // The switcher stays mounted permanently, but may render zero buttons when a
  // run only has one available view.
  const root = document.createElement('div');

  root.className = 'view-switcher is-hidden';
  container.appendChild(root);

  return {
    update(viewOptions, selectedId) {
      // Rebuild from scratch because the option count is tiny and the full set
      // can change when the user jumps between simulation families or run ids.
      root.innerHTML = '';

      if (viewOptions.length <= 1) {
        root.classList.add('is-hidden');

        return;
      }

      // More than one view means the switcher becomes relevant and should be shown.
      root.classList.remove('is-hidden');

      for (const view of viewOptions) {
        const row = document.createElement('div');

        row.className = 'view-switcher__row';

        const button = document.createElement('button');

        button.className = 'view-switcher__button';
        button.type = 'button';
        button.dataset.viewId = view.id;
        button.classList.toggle('is-active', view.id === selectedId);
        button.setAttribute('aria-pressed', String(view.id === selectedId));
        button.setAttribute('aria-label', view.label ?? view.id);

        // Optional icons give the astrophysics-heavy views some visual identity
        // without forcing labels like "dark-matter" to do all the work.
        const icon = createViewIcon(view.icon);

        if (icon) {
          const iconWrap = document.createElement('span');

          iconWrap.className = 'view-switcher__icon';
          iconWrap.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);
          button.appendChild(iconWrap);
        }

        const label = document.createElement('span');

        label.className = 'view-switcher__label';
        label.textContent = view.label ?? view.id;
        button.appendChild(label);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          options.onSelect(view.id);
        });
        row.appendChild(button);

        if (view.description) {
          const infoBtn = document.createElement('button');

          infoBtn.className = 'view-switcher__info';
          infoBtn.type = 'button';
          infoBtn.setAttribute('aria-label', `Info about ${view.label ?? view.id}`);
          infoBtn.appendChild(createInfoIcon());
          infoBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            options.onInfo(view.id, view.label ?? view.id, view.description ?? '');
          });
          row.appendChild(infoBtn);
        }

        root.appendChild(row);
      }
    },
    hide() {
      // Hide also clears buttons so stale run-specific views cannot flash when
      // the next run loads.
      root.innerHTML = '';
      root.classList.add('is-hidden');
    },
  };
}

function createViewIcon(iconId?: string): SVGSVGElement | null {
  // View ids map to tiny inline SVGs so we keep this feature self-contained and
  // do not need a separate icon asset pipeline.
  switch (iconId) {
    case 'icon_houdini':
      return createSvg(`
        <rect x="4.5" y="8" width="9.8" height="8" rx="1.2"></rect>
        <path d="M14.3 10.1 19.5 7.3v9.4l-5.2-2.8Z"></path>
        <circle cx="8" cy="7" r="1.4"></circle>
        <circle cx="11.3" cy="7" r="1.4"></circle>
      `);
    case 'icon_material':
      return createSvg(`
        <path d="M12 4.6a7.4 7.4 0 1 0 7.4 7.4"></path>
        <path d="M12 12V4.6"></path>
        <path d="M12 12h7.4"></path>
        <path d="M12 8.8a3.2 3.2 0 0 1 3.2 3.2"></path>
        <path d="M12 12V8.8"></path>
        <path d="M12 12h3.2"></path>
      `);
    case 'icon_temperature':
      return createSvg(`
        <path d="M10.8 6.2a2.2 2.2 0 0 1 4.4 0v7.1a4.2 4.2 0 1 1-4.4 0Z"></path>
        <path d="M13 8.3v7.1"></path>
        <circle cx="13" cy="17.5" r="1.6" fill="currentColor" stroke="none"></circle>
      `);
    case 'icon_pressure':
      return createSvg(`
        <path d="M5.2 16a6.8 6.8 0 1 1 13.6 0"></path>
        <path d="M12 9.2v2"></path>
        <path d="M8.2 10.8 9.4 12"></path>
        <path d="M15.8 10.8 14.6 12"></path>
        <path d="M12 16 16.4 11.8"></path>
        <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"></circle>
      `);
    case 'dark-matter':
      return createSvg(`
        <circle cx="12" cy="12" r="6.5"></circle>
        <ellipse cx="12" cy="12" rx="10" ry="4.2"></ellipse>
        <circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"></circle>
        <circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none"></circle>
        <circle cx="12" cy="7.2" r="1.1" fill="currentColor" stroke="none"></circle>
      `);
    case 'gas-density':
      return createSvg(`
        <path d="M6 14c0-3.6 2.7-6.2 6-6.2 2.1 0 4 .9 5.1 2.5 2.5.2 4.4 2.1 4.4 4.6 0 2.7-2.1 4.7-4.9 4.7H10.2C7.7 19.6 6 17.4 6 14Z"></path>
        <path d="M9.2 13.6h5.6"></path>
        <path d="M8.5 16.2h7.8"></path>
      `);
    case 'gas-temperature':
      return createSvg(`
        <path d="M12 5.2a2.2 2.2 0 0 1 2.2 2.2v7.2a4 4 0 1 1-4.4 0V7.4A2.2 2.2 0 0 1 12 5.2Z"></path>
        <path d="M12 10v6.6"></path>
        <circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none"></circle>
      `);
    case 'metals-stars':
      return createSvg(`
        <rect x="4.8" y="4.8" width="14.4" height="14.4"></rect>
        <path d="m12 8.2 1.25 2.55 2.82.41-2.04 1.98.48 2.8L12 14.63 9.49 15.94l.48-2.8-2.04-1.98 2.82-.41L12 8.2Z"></path>
        <path d="M7.2 7.2h2.5"></path>
        <path d="M14.3 16.8h2.5"></path>
      `);
    case 'hubble-space-telescope':
      return createSvg(`
        <path d="M12 4.5v5.2"></path>
        <path d="M8.2 7.1 15.8 7.1"></path>
        <path d="M10.1 9.7h3.8v6.3h-3.8z"></path>
        <path d="M7.2 16 16.8 16"></path>
        <path d="M9.1 16 7 19.5"></path>
        <path d="M14.9 16 17 19.5"></path>
        <path d="M6.3 19.5h11.4"></path>
      `);
    case 'turntable':
      return createSvg(`
        <ellipse cx="12" cy="17.2" rx="7.6" ry="1.8"></ellipse>
        <path d="M12 6.2v6.4"></path>
        <path d="m12 6.2-2.6 2"></path>
        <path d="m12 6.2 2.6 2"></path>
        <path d="M12 12.6l-2.6-2"></path>
        <path d="M12 12.6l2.6-2"></path>
      `);
    case 'large-scale-structure':
      return createSvg(`
        <circle cx="6" cy="7" r="1.4"></circle>
        <circle cx="18" cy="6" r="1.2"></circle>
        <circle cx="12" cy="12" r="1.5"></circle>
        <circle cx="7.5" cy="17" r="1.2"></circle>
        <circle cx="17.5" cy="18" r="1.4"></circle>
        <path d="M7.1 7.7 10.9 11"></path>
        <path d="M13.4 11 16.9 6.9"></path>
        <path d="M11.3 13.3 8.3 16"></path>
        <path d="M13.1 13.5 16.4 16.9"></path>
        <path d="M8.8 17.2 16.2 17.8"></path>
      `);
    case 'line-trace':
      return createSvg(`
        <path d="M3.5 14.5h3l2.2-5 2.8 9 2.4-6 1.8 2.5H20.5"></path>
        <path d="M3.5 19.5h17"></path>
        <circle cx="8.7" cy="9.5" r="0.9" fill="currentColor" stroke="none"></circle>
        <circle cx="11.5" cy="18.5" r="0.9" fill="currentColor" stroke="none"></circle>
      `);
    default:
      return null;
  }
}

function createSvg(content: string): SVGSVGElement {
  // Build the SVG wrapper once per icon and inject the specific path markup.
  const template = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  template.setAttribute('viewBox', '0 0 24 24');
  template.setAttribute('fill', 'none');
  template.setAttribute('stroke', 'currentColor');
  template.setAttribute('stroke-width', '1.5');
  template.setAttribute('stroke-linecap', 'round');
  template.setAttribute('stroke-linejoin', 'round');
  template.innerHTML = content;

  return template;
}

function createInfoIcon(): SVGSVGElement {
  return createSvg(`
    <circle cx="12" cy="12" r="10"></circle>
    <path d="M12 16.5v-6"></path>
    <circle cx="12" cy="8.5" r="1.1" fill="currentColor" stroke="none"></circle>
  `);
}
