import { withBaseUrl } from '../shared/urls.ts';
import { ABOUT_CONTENT } from './about-content.ts';

export interface EntryInfoOverlayController {
  infoButton: HTMLButtonElement;
  infoModal: HTMLDivElement;
  open: () => void;
  close: () => void;
}

export function createEntryInfoOverlay(): EntryInfoOverlayController {
  const aboutImageSrc = withBaseUrl(ABOUT_CONTENT.imageSrc);
  const bodyMarkup = ABOUT_CONTENT.body
    .map((copy) => `<p class="entry-info-modal__copy">${copy}</p>`)
    .join('');

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
            <p class="entry-info-modal__eyebrow">${ABOUT_CONTENT.mediaEyebrow}</p>
            <h2 class="entry-info-modal__headline">${ABOUT_CONTENT.mediaHeadline}</h2>
          </div>
        </div>
        <div class="entry-info-modal__content">
          <div class="entry-info-modal__header">
            <p class="entry-info-modal__eyebrow">${ABOUT_CONTENT.headerEyebrow}</p>
            <h2 class="entry-info-modal__title">${ABOUT_CONTENT.title}</h2>
            <p class="entry-info-modal__subtitle">${ABOUT_CONTENT.subtitle}</p>
          </div>
          <div class="entry-info-modal__body">
            <section class="entry-info-modal__section">
              ${bodyMarkup}
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
