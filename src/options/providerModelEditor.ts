import { sendRuntime } from '../messaging/messages';
import { supportsProviderModelList, type ProviderConfig, type ProviderModel } from '../shared/types';

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
  const views = new Map<string, ModelListView>();

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

  function render(): void {
    const view = selectedView();
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
  model.addEventListener('input', syncModelSelection);
  for (const input of [baseUrl, apiKey, headers]) input.addEventListener('input', render);
  modeButton.addEventListener('click', () => {
    const view = selectedView();
    if (!view) return;
    view.manual = !view.manual;
    render();
    if (view.manual) model.focus();
    else if (!picker.disabled) picker.focus();
  });
  fetchButton.addEventListener('click', () => void fetchModels());
  return render;
}
