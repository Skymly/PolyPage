/**
 * Keep an unknown Provider type visible in the Options <select> (M-56).
 */

export function ensureSelectOption(select: HTMLSelectElement, value: string, label: string): void {
  if ([...select.options].some((o) => o.value === value)) return;
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  select.appendChild(opt);
}
