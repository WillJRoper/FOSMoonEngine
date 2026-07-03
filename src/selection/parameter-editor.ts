/**
 * Parameter editor — card-based controls for the selection overlay.
 *
 * Renders one res-card per parameter with a slider, value readout, and
 * a click-to-reveal centred description modal.
 */

import type { SimulationClass, SimParameter } from './simulation-catalog.ts';
import { formatParameterValue, withUnit } from '../shared/format.ts';

export interface ParameterEditorController {
  /** Swap to a different simulation family and optionally seed its values. */
  setSimClass: (simClass: SimulationClass, nextValues?: Record<string, number>) => void;

  /** Replace the current value map for the active simulation family. */
  setValues: (nextValues: Record<string, number>) => void;

  /** Read a defensive copy of the current values. */
  getValues: () => Record<string, number>;
}

/**
 * Create the parameter editor inside the provided host element.
 *
 * @param container - Host element to mount into.
 * @param initialSimClass - Initial simulation family.
 * @param initialValues - Initial values keyed by parameter id.
 * @param onChange - Callback fired whenever values change.
 * @returns Controller for updating the editor state.
 */
export function createParameterEditor(
  container: HTMLElement,
  initialSimClass: SimulationClass,
  initialValues: Record<string, number>,
  onChange: (values: Record<string, number>) => void,
): ParameterEditorController {
  const root = document.createElement('div');

  root.className = 'parameter-editor';
  container.appendChild(root);

  let currentClass = initialSimClass;
  let values = { ...initialValues };

  function render(
    simClass: SimulationClass,
    nextValues?: Record<string, number>,
  ): void {
    currentClass = simClass;
    values = nextValues ? { ...nextValues } : createFallbackValues(simClass);
    root.innerHTML = '';

    const heading = document.createElement('div');

    heading.className = 'parameter-editor__heading';
    heading.innerHTML = `
      <p class="parameter-editor__eyebrow">Parameter matrix</p>
      <h2 class="parameter-editor__title">${simClass.label} Controls</h2>
    `;
    root.appendChild(heading);

    const modal = document.createElement('div');

    modal.className = 'param-info-modal is-hidden';
    modal.innerHTML = `
      <div class="sci-modal__card">
        <button class="sci-modal__close" type="button" aria-label="Close">\u2715</button>
        <div class="sci-modal__title"></div>
        <div class="sci-modal__body"></div>
      </div>
    `;
    root.appendChild(modal);

    const modalTitle = modal.querySelector('.sci-modal__title') as HTMLElement;
    const modalBody = modal.querySelector('.sci-modal__body') as HTMLElement;
    const modalClose = modal.querySelector('.sci-modal__close') as HTMLElement;

    function openModal(title: string, description: string): void {
      modalTitle.textContent = title;
      modalBody.textContent = description;
      modal.classList.remove('is-hidden');
    }

    function closeModal(): void {
      modal.classList.add('is-hidden');
    }

    modalClose.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });

    const list = document.createElement('div');

    list.className = 'parameter-editor__list';

    for (const parameter of simClass.parameters) {
      list.appendChild(createParamControl(parameter, openModal));
    }

    root.appendChild(list);
    emitChange();
  }

  function createParamControl(
    param: SimParameter,
    openModal: (title: string, description: string) => void,
  ): HTMLElement {
    const card = document.createElement('div');

    card.className = 'res-card param-card';

    const header = document.createElement('div');

    header.className = 'param-card__header';

    const name = document.createElement('span');

    name.className = 'res-card__label';
    name.textContent = param.label;

    const displayUnit = param.displayUnit ?? param.unit;
    const isQualitative = param.displayFormat === 'qualitative' && param.qualiLabels && param.qualiLabels.length > 0;

    const range = document.createElement('span');

    range.className = 'param-card__range';
    if (isQualitative) {
      const labels = param.qualiLabels!;
      range.textContent = `${labels[0]} \u2013 ${labels[labels.length - 1]}`;
    } else {
      range.textContent = `${withUnit(formatParameterValue(param.min, param.step, { scale: param.valueScale, format: param.displayFormat, significantFigures: param.displaySignificantFigures }), displayUnit)} \u2013 ${withUnit(formatParameterValue(param.max, param.step, { scale: param.valueScale, format: param.displayFormat, significantFigures: param.displaySignificantFigures }), displayUnit)}`;
    }

    header.appendChild(name);
    header.appendChild(range);

    const slider = document.createElement('input');

    slider.className = 'param-card__slider';
    slider.type = 'range';

    const rawValue = values[param.id] ?? param.fallbackValue;

    if (isQualitative) {
      const labelCount = param.qualiLabels!.length;

      slider.min = '0';
      slider.max = String(labelCount - 1);
      slider.step = 'any';
      slider.value = String(Math.round(rawValue));
    } else {
      const sliderMin = param.logScale ? Math.log10(param.min) : param.min;
      const sliderMax = param.logScale ? Math.log10(param.max) : param.max;

      slider.min = String(sliderMin);
      slider.max = String(sliderMax);
      slider.step = param.logScale ? '0.001' : String(param.step);
      slider.value = String(
        param.logScale ? Math.log10(Math.max(rawValue, Number.MIN_VALUE)) : rawValue,
      );
    }
    slider.setAttribute('aria-label', param.label);

    const readout = document.createElement('span');

    readout.className = 'res-card__value';

    function sync(raw: number): void {
      if (isQualitative) {
        const index = Math.round(raw);
        const labels = param.qualiLabels!;

        values[param.id] = index;
        slider.style.setProperty(
          '--fill',
          `${calculateFill(raw, 0, labels.length - 1)}%`,
        );
        readout.textContent = labels[index] ?? String(index);
      } else {
        const value = param.logScale ? 10 ** raw : raw;

        values[param.id] = value;
        slider.value = String(raw);
        slider.style.setProperty(
          '--fill',
          `${calculateFill(raw, parseFloat(slider.min), parseFloat(slider.max))}%`,
        );
        readout.textContent = withUnit(
          formatParameterValue(value, param.step, {
            scale: param.valueScale,
            format: param.displayFormat,
            significantFigures: param.displaySignificantFigures,
          }),
          displayUnit,
        );
      }
      emitChange();
    }

    slider.addEventListener('input', () => {
      sync(parseFloat(slider.value));
    });

    slider.addEventListener('pointerdown', (e) => e.stopPropagation());
    slider.addEventListener('click', (e) => e.stopPropagation());

    if (isQualitative) {
      const index = Math.round(rawValue);
      const labels = param.qualiLabels!;

      slider.style.setProperty(
        '--fill',
        `${calculateFill(index, 0, labels.length - 1)}%`,
      );
      readout.textContent = labels[index] ?? String(index);
    } else {
      const initialSliderVal = param.logScale
        ? Math.log10(Math.max(rawValue, Number.MIN_VALUE))
        : rawValue;

      slider.style.setProperty(
        '--fill',
        `${calculateFill(initialSliderVal, parseFloat(slider.min), parseFloat(slider.max))}%`,
      );
      readout.textContent = withUnit(
        formatParameterValue(rawValue, param.step, {
          scale: param.valueScale,
          format: param.displayFormat,
          significantFigures: param.displaySignificantFigures,
        }),
        displayUnit,
      );
    }

    if (param.description) {
      card.classList.add('res-card--has-info');
      card.setAttribute('title', param.description);

      const infoBtn = document.createElement('span');

      infoBtn.className = 'param-card__info-btn';
      infoBtn.setAttribute('aria-label', 'Parameter description');
      infoBtn.textContent = '\u24D8';
      header.appendChild(infoBtn);

      card.addEventListener('click', () => {
        openModal(param.label, param.description!);
      });
    }

    card.appendChild(header);
    card.appendChild(slider);
    card.appendChild(readout);

    return card;
  }

  function emitChange(): void {
    onChange({ ...values });
  }

  render(initialSimClass, initialValues);

  return {
    setSimClass(simClass: SimulationClass, nextValues?: Record<string, number>) {
      render(simClass, nextValues);
    },
    setValues(nextValues: Record<string, number>) {
      render(currentClass, nextValues);
    },
    getValues() {
      return { ...values };
    },
  };
}

function createFallbackValues(simClass: SimulationClass): Record<string, number> {
  return Object.fromEntries(
    simClass.parameters.map((parameter) => [parameter.id, parameter.fallbackValue]),
  );
}

function calculateFill(value: number, min: number, max: number): number {
  if (max === min) {
    return 0;
  }

  return ((value - min) / (max - min)) * 100;
}
