import { withBaseUrl } from '../shared/urls.ts';

export interface EntryInfoOverlayController {
  infoButton: HTMLButtonElement;
  infoModal: HTMLDivElement;
  open: () => void;
  close: () => void;
}

export function createEntryInfoOverlay(): EntryInfoOverlayController {
  const aboutImageSrc = withBaseUrl('assets/2-McAlpine.webp');

  const infoModal = document.createElement('div');
  const infoButton = document.createElement('button');

  infoButton.className = 'view-switcher__info entry-overlay__info-button';
  infoButton.type = 'button';
  infoButton.setAttribute('aria-label', 'About this experience');
  infoButton.appendChild(createInfoIcon());

  infoModal.className = 'sci-modal is-hidden';
  infoModal.innerHTML = `
    <div class="entry-info-modal">
      <button class="entry-info-modal__close" type="button" aria-label="Close">×</button>
      <div class="entry-info-modal__shell">
        <div class="entry-info-modal__media">
          <img
            class="entry-info-modal__image"
            src="${aboutImageSrc}"
            alt="FOS Moon Engine preview"
            width="1920"
            height="1080"
            decoding="async"
          />
          <div class="entry-info-modal__media-copy">
            <p class="entry-info-modal__eyebrow">FOS Moon Engine</p>
            <h2 class="entry-info-modal__headline">Explore Cosmic Collisions On Human Scales</h2>
          </div>
        </div>
        <div class="entry-info-modal__content">
          <div class="entry-info-modal__header">
            <p class="entry-info-modal__eyebrow">About</p>
            <h2 class="entry-info-modal__title">What Is This Experience?</h2>
            <p class="entry-info-modal__subtitle">
              FOS Moon Engine turns large scientific simulations into an interactive hands-on experience
            </p>
          </div>
          <div class="entry-info-modal__body">
            <section class="entry-info-modal__section">
              <p class="entry-info-modal__copy">
                Choose your impact parameters, select your inputs, and see how those decisions reshape a planet.
              </p>
              <p class="entry-info-modal__copy">
                Run your own simulations of proto-planetary impacts and compare your choices with real scientific targets.
              </p>
            </section>
            <section class="entry-info-modal__section">
              <h3 class="entry-info-modal__section-title">Planetary Scale</h3>
              <div class="entry-info-modal__theme-list">
                <div class="entry-info-modal__theme">
                  <p class="entry-info-modal__theme-title">Planetary</p>
                  <p class="entry-info-modal__copy">
                    Even the smallest changes in angle, speed, or mass can completely transform how a giant
                    impact unfolds. See if you can find the right combination to form a Moon like ours, and uncover
                    the hidden interplay between the initial conditions that turns planetary chaos into an Earth–Moon system.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `;

  const infoModalClose = infoModal.querySelector(
    '.entry-info-modal__close',
  ) as HTMLButtonElement;

  function open(): void {
    infoModal.classList.remove('is-hidden');
  }

  function close(): void {
    infoModal.classList.add('is-hidden');
  }

  infoButton.addEventListener('click', open);
  infoModalClose.addEventListener('click', close);
  infoModal.addEventListener('click', (event) => {
    if (event.target === infoModal) {
      close();
    }
  });

  return { infoButton, infoModal, open, close };
}

function createSvg(content: string): SVGSVGElement {
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
