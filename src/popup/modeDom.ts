/**
 * Popup mode radios without innerHTML (M-98).
 */
import type { DisplayMode } from '../shared/types';

export function renderModeItem(
  mode: DisplayMode,
  meta: { name: string; desc: string },
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'mode-item';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'mode';
  input.value = mode;
  const wrap = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'mode-name';
  name.textContent = meta.name;
  const desc = document.createElement('span');
  desc.className = 'mode-desc';
  desc.textContent = meta.desc;
  wrap.append(name, document.createElement('br'), desc);
  label.append(input, wrap);
  return label;
}
