/**
 * Options shortcut rows without innerHTML (M-98).
 */
export function renderShortcutRow(cmd: {
  description?: string;
  name?: string;
  shortcut?: string;
}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'shortcut-row';
  const label = document.createElement('span');
  label.textContent = cmd.description || cmd.name || '';
  const kbd = document.createElement('kbd');
  kbd.textContent = cmd.shortcut || '未设置';
  row.append(label, kbd);
  return row;
}
