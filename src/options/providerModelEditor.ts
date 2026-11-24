import { sendRuntime } from '../messaging/messages';
import { minimaxThinkingLevels, parseThinkingLevel, REASONING_EFFORTS, type ThinkingLevel } from '../shared/modelThinking';
import { supportsProviderModelList, type ProviderConfig, type ProviderModel } from '../shared/types';

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  none: '关闭',
  enabled: '开启',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '特高',
  max: '最高',
};

interface ModelListView {
  connection: string;
  models: ProviderModel[];
  manual: boolean;
  loading: boolean;
  message: string;
}

export function setupProviderModelEditor(
  $: <T extends HTMLElement>(id: string) => T,
  selectedProvider: () => ProviderConfig | null,
  collectEditor: () => boolean,
): () => void {
  const baseUrl = $<HTMLInputElement>('f-baseurl');
  const apiKey = $<HTMLInputElement>('f-apikey');
  const headers = $<HTMLTextAreaElement>('f-headers');
  const model = $<HTMLInputElement>('f-model');
  const label = $<HTMLLabelElement>('provider-model-label');
  const picker = $<HTMLSelectElement>('provider-model-select');
  const fetchButton = $<HTMLButtonElement>('provider-model-fetch');
  const modeButton = $<HTMLButtonElement>('provider-model-mode');
  const status = $('provider-model-status');
  const thinking = $<HTMLSelectElement>('f-thinking-level');
  const thinkingField = $('field-thinking-level');
  const thinkingHint = $('thinking-level-hint');
  const views = new Map<string, ModelListView>();
  let thinkingModel = '';

  function selectedView(): ModelListView | undefined {
    const provider = selectedProvider();
    if (!provider || !supportsProviderModelList(provider.type)) return;
    const connection = JSON.stringify([provider.type, baseUrl.value.trim(), apiKey.value.trim(), headers.value.trim()]);
    const current = views.get(provider.id);
    if (current?.connection === connection) return current;
    const view = { connection, models: [], manual: false, loading: false, message: '' };
    views.set(provider.id, view);
    return view;
  }

  function syncModelSelection(): void {
    const id = model.value.trim();
    picker.querySelector('option[data-current-model]')?.remove();
    picker.value = id;
    if (id && picker.selectedIndex === -1) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      option.dataset.currentModel = '';
      picker.prepend(option);
      picker.value = id;
    }
  }

  function thinkingModelId(): string {
    const id = model.value.trim();
    return selectedProvider()?.type === 'opencode-go' ? id.replace(/^opencode-go\//, '') : id;
  }

  function renderThinking(view: ModelListView | undefined, level: ThinkingLevel | ''): void {
    thinkingField.classList.toggle('hidden', !view);
    thinkingModel = thinkingModelId();
    if (!view) {
      thinking.replaceChildren();
      return;
    }
    const catalogModel = view.models.find(({ id }) => id === thinkingModel);
    const supported = minimaxThinkingLevels(baseUrl.value, thinkingModel) ?? catalogModel?.reasoningEfforts;
    const levels = supported ?? REASONING_EFFORTS;
    const options = [{ value: '', label: '默认' }, ...levels.map((value) => ({ value, label: THINKING_LABELS[value] }))];
    const unavailable = level && !levels.includes(level);
    if (unavailable) {
      options.push({ value: level, label: `${THINKING_LABELS[level]}（当前配置）` });
    }
    thinking.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    thinking.value = level;
    thinking.disabled = levels.length === 0 && !level;
    if (unavailable) {
      thinkingHint.textContent = '当前配置的档位不在此模型的可用选项中。';
    } else if (supported === undefined) {
      thinkingHint.textContent = '可用档位取决于模型和接口。';
    } else {
      thinkingHint.textContent = thinking.disabled ? '当前模型未提供可设置的思考档位。' : '';
    }
    thinkingHint.hidden = !thinkingHint.textContent;
  }

  function render(level: ThinkingLevel | '' = parseThinkingLevel(thinking.value) ?? ''): void {
    const view = selectedView();
    renderThinking(view, level);
    const showPicker = !!view && !view.manual;
    picker.classList.toggle('hidden', !showPicker);
    model.classList.toggle('hidden', showPicker);
    $('provider-model-actions').classList.toggle('hidden', !view);
    label.htmlFor = showPicker ? picker.id : model.id;
    if (!view) return;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择模型';
    placeholder.disabled = true;
    picker.replaceChildren(placeholder);
    for (const { id, name } of view.models) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name === id ? id : `${name} · ${id}`;
      picker.append(option);
    }
    syncModelSelection();
    picker.disabled = view.models.length === 0;
    fetchButton.disabled = view.loading;
    fetchButton.textContent = view.loading ? '获取中…' : view.models.length ? '刷新模型列表' : '获取模型列表';
    modeButton.textContent = view.manual ? '从列表选择' : '手动输入';
    status.textContent = view.message;
  }

  async function fetchModels(): Promise<void> {
    if (!collectEditor()) return;
    const provider = selectedProvider();
    const view = selectedView();
    if (!provider || !view || view.loading) return;
    view.loading = true;
    view.message = '';
    render();
    try {
      const response = await sendRuntime({ type: 'list-provider-models', provider });
      if (!response?.ok) throw new Error(response?.error ?? '无法获取模型列表');
      view.models = response.models;
      view.manual = false;
      view.message = `已获取 ${response.models.length} 个模型`;
    } catch (error) {
      view.message = error instanceof Error ? error.message : '无法获取模型列表';
      if (!view.models.length) view.manual = true;
    } finally {
      view.loading = false;
      if (view === selectedView()) render();
    }
  }

  picker.addEventListener('change', () => {
    if (!picker.value) return;
    model.value = picker.value;
    model.dispatchEvent(new Event('input', { bubbles: true }));
  });
  model.addEventListener('input', () => {
    syncModelSelection();
    if (thinkingModelId() !== thinkingModel) renderThinking(selectedView(), '');
  });
  thinking.addEventListener('change', () => renderThinking(selectedView(), parseThinkingLevel(thinking.value) ?? ''));
  for (const input of [baseUrl, apiKey, headers]) input.addEventListener('input', () => render());
  modeButton.addEventListener('click', () => {
    const view = selectedView();
    if (!view) return;
    view.manual = !view.manual;
    render();
    if (view.manual) model.focus();
    else if (!picker.disabled) picker.focus();
  });
  fetchButton.addEventListener('click', () => void fetchModels());
  return () => render(selectedProvider()?.thinkingLevel ?? '');
}
