/**
 * Options error/feedback log rows. Remote strings must never go through innerHTML (M-38).
 */

export function renderErrorLogEntry(opts: {
  time: string;
  kind: string;
  provider?: string;
  message: string;
}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'log-entry';
  const meta = document.createElement('span');
  meta.className = 'log-meta';
  meta.textContent = opts.time;
  const kind = document.createElement('span');
  kind.className = 'log-kind';
  kind.textContent = opts.kind;
  row.append(meta, kind);
  if (opts.provider) {
    const provider = document.createElement('span');
    provider.className = 'log-provider';
    provider.textContent = `[${opts.provider}]`;
    row.appendChild(provider);
  }
  const message = document.createElement('span');
  message.textContent = opts.message;
  row.appendChild(message);
  return row;
}

export function renderFeedbackLogHead(opts: {
  time: string;
  providerName?: string;
  where: string;
}): HTMLDivElement {
  const head = document.createElement('div');
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = opts.time;
  const provider = document.createElement('span');
  provider.className = 'log-provider';
  provider.textContent = `[${opts.providerName ?? '?'} / ${opts.where}]`;
  head.append(time, document.createTextNode(' '), provider);
  return head;
}
