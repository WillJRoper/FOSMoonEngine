/**
 * Overlay panel — a generic multi-purpose modal reused across the app.
 *
 * This is a shell with three tabbed subviews. The settings view also contains
 * the password-gated advanced controls used for kiosk/exhibit configuration.
 */

import type { SimulationClass } from './simulation-catalog.ts';
import { getCredits } from '../data/credits.ts';
import { createParameterEditor } from './parameter-editor.ts';
import {
  createThemePicker,
  type ThemeId,
  type ThemePickerController,
} from './theme.ts';
import { withBaseUrl } from '../shared/urls.ts';
import {
  ADVANCED_SETTINGS_PASSWORD,
  type AdvancedSettings,
} from '../shared/advanced-settings.ts';

export interface OverlayPanelController {
  show: () => void;
  hide: () => void;
  setSimulation: (simClass: SimulationClass, values: Record<string, number>) => void;
  setTheme: (theme: ThemeId) => void;
  setView: (view: OverlayPanelView) => void;
  setAdvancedSettings: (settings: AdvancedSettings) => void;
  setBackVisible: (visible: boolean) => void;
}

export type OverlayPanelView = 'parameters' | 'settings' | 'credits';

interface OverlayPanelOptions {
  simClass: SimulationClass;
  values: Record<string, number>;
  theme: ThemeId;
  advancedSettings: AdvancedSettings;
  availableScales: SimulationClass[];
  onValuesChange: (values: Record<string, number>) => void;
  onThemeChange: (theme: ThemeId) => void;
  onRun: () => void;
  onApplySettings: (settings: AdvancedSettings) => void;
  onResetGalleryProgress: () => void;
  onClose: () => void;
  initialView?: OverlayPanelView;
}

export function createOverlayPanel(
  container: HTMLElement,
  options: OverlayPanelOptions,
): OverlayPanelController {
  const overlay = document.createElement('section');

  overlay.className = 'overlay overlay--config';
  overlay.hidden = true;
  overlay.classList.add('is-hidden');

  const panel = document.createElement('div');

  panel.className = 'config-overlay';

  const shell = document.createElement('div');

  shell.className = 'config-overlay__shell';

  const media = document.createElement('div');

  media.className = 'config-overlay__media';
  media.dataset.simClass = options.simClass.id;
  const mediaImage = document.createElement('img');

  mediaImage.className = 'config-overlay__media-image';
  mediaImage.src = options.simClass.placeholderImage;
  mediaImage.alt = `${options.simClass.label} preview`;

  media.innerHTML = `
    <div class="config-overlay__media-copy">
      <h1 class="config-overlay__headline">Moon Engine</h1>
      <p class="config-overlay__media-subtitle"></p>
    </div>
  `;
  media.prepend(mediaImage);
  const mediaSubtitle = media.querySelector(
    '.config-overlay__media-subtitle',
  ) as HTMLParagraphElement;

  const charterMark = document.createElement('img');

  charterMark.className = 'config-overlay__chartermark';
  charterMark.src = withBaseUrl('assets/credits/fos-future-lab-logo.png');
  charterMark.alt = 'FOS Future Lab';
  charterMark.decoding = 'async';
  media.appendChild(charterMark);

  const controls = document.createElement('div');

  controls.className = 'config-overlay__controls';
  controls.dataset.view = options.initialView ?? 'parameters';

  const header = document.createElement('div');

  header.className = 'config-overlay__header';

  const titleBlock = document.createElement('div');

  titleBlock.className = 'config-overlay__title-block';
  titleBlock.innerHTML = `
    <p class="config-overlay__eyebrow"></p>
    <h2 class="config-overlay__title"></h2>
    <p class="config-overlay__subtitle"></p>
  `;
  const titleEyebrow = titleBlock.querySelector(
    '.config-overlay__eyebrow',
  ) as HTMLParagraphElement;
  const titleText = titleBlock.querySelector(
    '.config-overlay__title',
  ) as HTMLHeadingElement;
  const titleSubtitle = titleBlock.querySelector(
    '.config-overlay__subtitle',
  ) as HTMLParagraphElement;

  const closeButton = document.createElement('button');

  closeButton.className = 'config-overlay__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';

  header.appendChild(titleBlock);
  header.appendChild(closeButton);

  const parameterSection = document.createElement('section');

  parameterSection.className = 'config-overlay__section config-overlay__section--grow';
  parameterSection.dataset.section = 'parameters';
  const parametersHost = document.createElement('div');

  parameterSection.appendChild(parametersHost);

  const settingsSection = document.createElement('section');

  settingsSection.className = 'config-overlay__section config-overlay__section--grow';
  settingsSection.dataset.section = 'settings';
  const themePickerHost = document.createElement('div');
  themePickerHost.className = 'config-overlay__settings-block';
  themePickerHost.innerHTML = `
    <p class="config-overlay__eyebrow">Theme settings</p>
    <p class="config-overlay__settings-copy">Theme only for this pass. Choose the interface era here.</p>
  `;
  settingsSection.appendChild(themePickerHost);

  const gallerySettings = document.createElement('section');

  gallerySettings.className = 'config-overlay__settings-block';
  gallerySettings.innerHTML = `
    <p class="config-overlay__eyebrow">Gallery</p>
    <p class="config-overlay__settings-copy">Clear the discovered runs for the current simulation family and start the gallery cycle again.</p>
  `;
  const resetGalleryButton = document.createElement('button');

  resetGalleryButton.className = 'advanced-settings__access';
  resetGalleryButton.type = 'button';
  resetGalleryButton.textContent = 'Reset Gallery Progress';
  gallerySettings.appendChild(resetGalleryButton);
  settingsSection.appendChild(gallerySettings);

  const advancedPanel = document.createElement('section');

  advancedPanel.className = 'advanced-settings config-overlay__settings-block';
  advancedPanel.dataset.state = 'closed';
  advancedPanel.innerHTML = `
    <div class="advanced-settings__header">
      <p class="config-overlay__eyebrow">Advanced settings</p>
      <p class="config-overlay__settings-copy">Password-gated controls for logging, scale visibility, and fullscreen behavior.</p>
    </div>
  `;

  const advancedAccessButton = document.createElement('button');

  advancedAccessButton.className = 'advanced-settings__access';
  advancedAccessButton.type = 'button';
  advancedAccessButton.textContent = 'Advanced Settings';
  advancedPanel.appendChild(advancedAccessButton);

  const advancedAuth = document.createElement('div');

  advancedAuth.className = 'advanced-settings__auth';
  const passwordInput = document.createElement('input');

  passwordInput.className = 'advanced-settings__password';
  passwordInput.type = 'password';
  passwordInput.placeholder = 'Enter password';
  passwordInput.autocomplete = 'off';

  const unlockButton = document.createElement('button');

  unlockButton.className = 'advanced-settings__unlock';
  unlockButton.type = 'button';
  unlockButton.textContent = 'Unlock';

  const authMessage = document.createElement('p');

  authMessage.className = 'advanced-settings__message';

  advancedAuth.appendChild(passwordInput);
  advancedAuth.appendChild(unlockButton);
  advancedAuth.appendChild(authMessage);
  advancedPanel.appendChild(advancedAuth);

  const advancedForm = document.createElement('div');

  advancedForm.className = 'advanced-settings__form';

  const verboseField = document.createElement('label');

  verboseField.className = 'advanced-settings__field advanced-settings__field--inline';
  const verboseInput = document.createElement('input');
  const verboseCopy = document.createElement('span');

  verboseInput.type = 'checkbox';
  verboseInput.className = 'advanced-settings__checkbox';
  verboseCopy.innerHTML = `
    <span class="advanced-settings__label">Verbose logging</span>
    <span class="advanced-settings__help">Adds parameter, manifest, and run-selection logs to the console.</span>
  `;
  verboseField.appendChild(verboseInput);
  verboseField.appendChild(verboseCopy);
  advancedForm.appendChild(verboseField);

  const fullscreenLockField = document.createElement('label');

  fullscreenLockField.className = 'advanced-settings__field advanced-settings__field--inline';
  const fullscreenLockInput = document.createElement('input');
  const fullscreenLockCopy = document.createElement('span');

  fullscreenLockInput.type = 'checkbox';
  fullscreenLockInput.className = 'advanced-settings__checkbox';
  fullscreenLockCopy.innerHTML = `
    <span class="advanced-settings__label">Lock fullscreen</span>
    <span class="advanced-settings__help">Remove the Fullscreen option from the burger menu to keep the app locked to fullscreen.</span>
  `;
  fullscreenLockField.appendChild(fullscreenLockInput);
  fullscreenLockField.appendChild(fullscreenLockCopy);
  advancedForm.appendChild(fullscreenLockField);

  const visibilityField = document.createElement('div');

  visibilityField.className = 'advanced-settings__field';
  visibilityField.innerHTML = `
    <span class="advanced-settings__label">Visible scales</span>
    <span class="advanced-settings__help">Hide scales from the landing screen without changing their data.</span>
  `;
  const visibilityOptions = document.createElement('div');

  visibilityOptions.className = 'advanced-settings__options';
  const visibilityInputs = new Map<string, HTMLInputElement>();

  for (const scale of options.availableScales) {
    const choice = document.createElement('label');
    const checkbox = document.createElement('input');

    choice.className = 'advanced-settings__choice';
    checkbox.type = 'checkbox';
    checkbox.value = scale.id;
    visibilityInputs.set(scale.id, checkbox);
    choice.appendChild(checkbox);
    choice.append(`Show ${scale.label}`);
    visibilityOptions.appendChild(choice);
  }

  visibilityField.appendChild(visibilityOptions);
  advancedForm.appendChild(visibilityField);
  advancedPanel.appendChild(advancedForm);
  settingsSection.appendChild(advancedPanel);

  const creditsSection = document.createElement('section');

  creditsSection.className = 'config-overlay__section config-overlay__section--grow';
  creditsSection.dataset.section = 'credits';
  creditsSection.innerHTML = `
    <div class="credits-list" data-credits></div>
  `;

  const creditsList = creditsSection.querySelector('[data-credits]') as HTMLDivElement;
  const credits = getCredits();

  creditsList.innerHTML = '';

  if (credits.length === 0) {
    const entry = document.createElement('div');

    entry.className = 'credits-list__entry';
    entry.textContent = 'To be credited...';
    creditsList.appendChild(entry);
  } else {
    for (const credit of credits) {
      if (credit.header) {
        const heading = document.createElement('div');

        heading.className = 'credits-list__heading';
        heading.textContent = credit.text;
        creditsList.appendChild(heading);
      } else {
        const entry = document.createElement('div');

        entry.className = 'credits-list__entry';
        const textSpan = document.createElement('span');

        textSpan.className = 'credits-list__text';

        if (credit.url) {
          const link = document.createElement('a');

          link.className = 'credits-list__link';
          link.href = credit.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = credit.text;
          textSpan.appendChild(link);
        } else {
          textSpan.textContent = credit.text;
        }

        entry.appendChild(textSpan);
        creditsList.appendChild(entry);
      }
    }
  }

  const footer = document.createElement('div');

  footer.className = 'config-overlay__footer';

  const footerButton = document.createElement('button');

  footerButton.className = 'run-button';
  footerButton.type = 'button';
  footerButton.textContent = 'Run';

  footer.appendChild(footerButton);

  controls.appendChild(header);
  controls.appendChild(parameterSection);
  controls.appendChild(settingsSection);
  controls.appendChild(creditsSection);
  controls.appendChild(footer);

  shell.appendChild(media);
  shell.appendChild(controls);
  panel.appendChild(shell);
  overlay.appendChild(panel);
  container.appendChild(overlay);

  let pendingAdvancedSettings = cloneAdvancedSettings(options.advancedSettings);
  let advancedState: 'closed' | 'auth' | 'open' = 'closed';
  let parameterBackVisible = true;

  const parameterEditor = createParameterEditor(
    parametersHost,
    options.simClass,
    options.values,
    options.onValuesChange,
  );
  const themePicker: ThemePickerController = createThemePicker(
    themePickerHost,
    options.theme,
    options.onThemeChange,
  );

  closeButton.addEventListener('click', options.onClose);
  resetGalleryButton.addEventListener('click', options.onResetGalleryProgress);
  advancedAccessButton.addEventListener('click', () => {
    if (advancedState === 'open') {
      setAdvancedPanelState('closed');

      return;
    }

    setAdvancedPanelState('auth');
    passwordInput.focus();
  });
  unlockButton.addEventListener('click', unlockAdvancedSettings);
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      unlockAdvancedSettings();
    }
  });

  verboseInput.addEventListener('change', () => {
    pendingAdvancedSettings.verboseLogging = verboseInput.checked;
  });
  fullscreenLockInput.addEventListener('change', () => {
    pendingAdvancedSettings.lockFullscreen = fullscreenLockInput.checked;
  });

  for (const [, checkbox] of visibilityInputs.entries()) {
    checkbox.addEventListener('change', () => {
      const visibleScaleIds = Array.from(visibilityInputs.entries())
        .filter(([, input]) => input.checked)
        .map(([id]) => id);

      if (visibleScaleIds.length === 0) {
        checkbox.checked = true;

        return;
      }

      pendingAdvancedSettings.hiddenScaleIds = Array.from(
        visibilityInputs.keys(),
      ).filter((id) => !visibilityInputs.get(id)?.checked);
      syncAdvancedControls();
    });
  }

  applyView(options.initialView ?? 'parameters');
  syncAdvancedControls();
  setBackVisible(parameterBackVisible);

  function applyView(view: OverlayPanelView): void {
    controls.dataset.view = view;

    if (view === 'parameters') {
      titleEyebrow.textContent = options.simClass.label;
      titleText.textContent = 'Shape Your Simulation';
      titleSubtitle.textContent =
        options.simClass.parameterSubtitle ??
        "Adjust the parameters, inspect the setup, and press 'Run' when you're ready.";
      mediaSubtitle.hidden = true;
      mediaImage.src = options.simClass.placeholderImage;
      mediaImage.alt = 'Simulation preview';
    } else if (view === 'settings') {
      titleEyebrow.textContent = 'Interface';
      titleText.textContent = 'Adjust The Control Room';
      titleSubtitle.textContent =
        'Change the interface theme and manage exhibit-level options for this installation.';
      mediaSubtitle.textContent = '';
      mediaSubtitle.hidden = true;
      mediaImage.src = withBaseUrl('assets/7-kegerreis-1.webp');
      mediaImage.alt = 'Moon impact simulation preview';
    } else {
      titleEyebrow.textContent = 'References';
      titleText.textContent = 'Project Sources And Attribution';
      titleSubtitle.textContent =
        'Review the datasets, imagery, and supporting materials behind this experience.';
      mediaSubtitle.textContent = '';
      mediaSubtitle.hidden = true;
      mediaImage.src = withBaseUrl('assets/jupiter-remix-credits.webp');
      mediaImage.alt = 'Moon impact simulation preview';
    }

    if (view === 'settings') {
      footerButton.textContent = 'Apply';
    } else {
      footerButton.textContent = 'Run Simulation';
    }

    footer.hidden = view === 'credits';
    syncCloseButton();
  }

  function syncCloseButton(): void {
    const activeView = controls.dataset.view as OverlayPanelView;

    closeButton.hidden = activeView !== 'settings' && activeView !== 'credits';
    closeButton.classList.toggle('is-hidden', activeView !== 'settings' && activeView !== 'credits');
  }

  function setBackVisible(visible: boolean): void {
    parameterBackVisible = visible;
    syncCloseButton();
  }

  function syncAdvancedControls(): void {
    verboseInput.checked = pendingAdvancedSettings.verboseLogging;
    fullscreenLockInput.checked = pendingAdvancedSettings.lockFullscreen;

    for (const [, checkbox] of visibilityInputs.entries()) {
      checkbox.checked = !pendingAdvancedSettings.hiddenScaleIds.includes(checkbox.value);
      checkbox.disabled = false;
    }
  }

  function unlockAdvancedSettings(): void {
    if (passwordInput.value !== ADVANCED_SETTINGS_PASSWORD) {
      authMessage.textContent = 'Incorrect password';

      return;
    }

    passwordInput.value = '';
    authMessage.textContent = '';
    setAdvancedPanelState('open');
  }

  function setAdvancedPanelState(state: 'closed' | 'auth' | 'open'): void {
    advancedState = state;
    advancedPanel.dataset.state = state;
    advancedAccessButton.textContent =
      state === 'open' ? 'Hide Advanced Settings' : 'Advanced Settings';

    if (state !== 'auth') {
      authMessage.textContent = '';
    }
  }

  function resetAdvancedPanel(): void {
    passwordInput.value = '';
    authMessage.textContent = '';
    setAdvancedPanelState('closed');
  }

  function resetAdvancedDraft(): void {
    pendingAdvancedSettings = cloneAdvancedSettings(options.advancedSettings);
    syncAdvancedControls();
  }

  footerButton.addEventListener('click', () => {
    const activeView = controls.dataset.view as OverlayPanelView;

    if (activeView === 'settings') {
      options.onApplySettings(cloneAdvancedSettings(pendingAdvancedSettings));

      return;
    }

    options.onRun();
  });

  return {
    show() {
      overlay.hidden = false;
      overlay.classList.remove('is-hidden');
    },
    hide() {
      overlay.hidden = true;
      overlay.classList.add('is-hidden');
      resetAdvancedDraft();
      resetAdvancedPanel();
    },
    setSimulation(simClass: SimulationClass, values: Record<string, number>) {
      options.simClass = simClass;
      media.dataset.simClass = simClass.id;
      parameterEditor.setSimClass(simClass, values);

      if ((controls.dataset.view as OverlayPanelView) === 'parameters') {
        mediaImage.src = simClass.placeholderImage;
        mediaImage.alt = `${simClass.label} preview`;
        applyView('parameters');
      }
    },
    setTheme(theme: ThemeId) {
      themePicker.setActive(theme);
    },
    setView(view: OverlayPanelView) {
      applyView(view);
      if (view !== 'settings') {
        resetAdvancedPanel();
      }
    },
    setAdvancedSettings(settings: AdvancedSettings) {
      options.advancedSettings = cloneAdvancedSettings(settings);
      pendingAdvancedSettings = cloneAdvancedSettings(settings);
      syncAdvancedControls();
      resetAdvancedPanel();
    },
    setBackVisible,
  };
}

function cloneAdvancedSettings(settings: AdvancedSettings): AdvancedSettings {
  return {
    lockedScaleId: settings.lockedScaleId,
    manifestSource: settings.manifestSource,
    verboseLogging: settings.verboseLogging,
    hiddenScaleIds: [...settings.hiddenScaleIds],
    audioMutedByDefault: settings.audioMutedByDefault,
    defaultAudioVolume: settings.defaultAudioVolume,
    lockFullscreen: settings.lockFullscreen,
  };
}
