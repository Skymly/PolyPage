import { sendRuntime } from '../messaging/messages';
import { OPENCODE_GO_QUOTA_MINUTES, OPENCODE_GO_QUOTA_STORAGE_PREFIX } from '../shared/constants';
import type { ProviderConfig } from '../shared/types';
import type { OpenCodeGoQuotaStatus, OpenCodeGoQuotaWindow } from '../providers/opencode-go';

const WINDOW_LABELS: Record<OpenCodeGoQuotaWindow, string> = {
  rolling: '5 小时',
  weekly: '每周',
  monthly: '每月',
};

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });

export function setupOpenCodeGoQuota(
  $: <T extends HTMLElement>(id: string) => T,
  selectedProvider: () => ProviderConfig | null,
): () => void {
  const apiKey = $<HTMLInputElement>('f-apikey');
  const quotaButton = $<HTMLButtonElement>('opencode-go-quota-refresh');
  const quotaWindows = $('opencode-go-quota-windows');
  const quotaStatus = $('opencode-go-quota-status');
  $('opencode-go-quota-minutes').textContent = String(OPENCODE_GO_QUOTA_MINUTES);

  let quotaIdentity: { providerId: string; apiKey: string } | undefined;
  let quotaRevision = 0;
  let querying = false;

  function renderQuota(status: OpenCodeGoQuotaStatus | null): void {
    quotaWindows.replaceChildren();
    const lastSuccess = status?.lastSuccess;
    quotaWindows.hidden = !lastSuccess;
    if (lastSuccess) {
      for (const window of Object.keys(WINDOW_LABELS) as OpenCodeGoQuotaWindow[]) {
        const { percent, resetsAt } = lastSuccess.windows[window];
        const row = document.createElement('div');
        const name = document.createElement('dt');
        name.textContent = WINDOW_LABELS[window];
        const value = document.createElement('dd');
        value.textContent = `剩余 ${percentFormat.format(Math.max(0, 1 - percent / 100))}`;
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = Math.max(0, 100 - percent);
        progress.setAttribute('aria-label', `${name.textContent}剩余额度`);
        value.append(progress);
        if (resetsAt) {
          const reset = document.createElement('time');
          reset.dateTime = resetsAt;
          reset.textContent = `${dateTime.format(new Date(resetsAt))} 重置`;
          value.append(reset);
        }
        row.append(name, value);
        quotaWindows.append(row);
      }
    }
    const updated = lastSuccess ? `${dateTime.format(lastSuccess.fetchedAt)} 更新` : '';
    quotaStatus.textContent = status?.error
      ? `${status.error}${updated ? `。显示上次结果，${updated}` : ''}`
      : updated || (quotaIdentity ? '尚无额度记录，可立即查询。' : '填写 API Key 后可查询额度。');
  }

  function syncQuotaIdentity(): void {
    const provider = selectedProvider();
    const key = apiKey.value.trim();
    const next = provider?.type === 'opencode-go' && key ? { providerId: provider.id, apiKey: key } : undefined;
    if (next?.providerId === quotaIdentity?.providerId && next?.apiKey === quotaIdentity?.apiKey) return;
    quotaIdentity = next;
    quotaRevision++;
    querying = false;
    quotaButton.disabled = !next;
    renderQuota(null);
  }

  async function refreshQuota(manual = false): Promise<void> {
    syncQuotaIdentity();
    if (!quotaIdentity || querying) return;
    const revision = ++quotaRevision;
    if (manual) {
      querying = true;
      quotaButton.disabled = true;
      quotaStatus.textContent = '正在查询额度…';
    }
    try {
      const response = await sendRuntime({ type: 'opencode-go-quota', ...quotaIdentity, refresh: manual });
      if (revision !== quotaRevision) return;
      if (!response.ok) throw new Error(response.error);
      if (response.status || manual) renderQuota(response.status);
    } catch (error) {
      if (revision === quotaRevision) quotaStatus.textContent = error instanceof Error ? error.message : '无法获取 OpenCode Go 额度';
    } finally {
      if (revision === quotaRevision) {
        querying = false;
        quotaButton.disabled = false;
      }
    }
  }

  quotaButton.disabled = true;
  renderQuota(null);
  quotaButton.addEventListener('click', () => void refreshQuota(true));
  apiKey.addEventListener('input', syncQuotaIdentity);
  apiKey.addEventListener('change', () => void refreshQuota());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((key) => key.startsWith(OPENCODE_GO_QUOTA_STORAGE_PREFIX))) {
      void refreshQuota();
    }
  });
  return () => void refreshQuota();
}
