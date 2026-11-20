// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionTranslator } from '../src/content/selection';
import type { StreamPortMessage } from '../src/messaging/messages';

const source = 'The blue fox hid a brass key.';

function mockPort() {
  let receive: (message: StreamPortMessage) => void = () => {};
  let disconnect: () => void = () => {};
  return {
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    receive: (message: StreamPortMessage) => receive(message),
    drop: () => disconnect(),
  };
}

function selectionPanel() {
  const shadow = document.querySelector('.wt-selection-host')!.shadowRoot!;
  return {
    panel: shadow.querySelector<HTMLElement>('.wt-sel-panel')!,
    text: shadow.querySelector('.wt-sel-text')!,
    close: [...shadow.querySelectorAll('button')].find((button) => button.textContent === '收起')!,
  };
}

describe('划词流式翻译', () => {
  let selection: SelectionTranslator;

  beforeEach(() => {
    selection = new SelectionTranslator();
    const paragraph = document.createElement('p');
    paragraph.textContent = source;
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
  });

  afterEach(() => {
    selection.destroy();
    window.getSelection()!.removeAllRanges();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders deltas while busy and displays the final result after finished', async () => {
    const port = mockPort();
    const connect = vi.fn(() => port);
    vi.stubGlobal('chrome', { runtime: { connect } });
    selection.setStreamingTarget('zh-CN');

    expect(selection.translateCurrentSelection()).toBe(true);
    const { panel, text } = selectionPanel();
    expect(connect).toHaveBeenCalledWith({ name: 'wt-stream' });
    expect(port.postMessage).toHaveBeenCalledWith({ items: [{ key: 'selection', text: source }], domain: location.hostname });
    expect(panel.getAttribute('aria-busy')).toBe('true');
    port.receive({ type: 'delta', key: 'selection', delta: '蓝狐狸' });
    expect(text.textContent).toBe('蓝狐狸');
    port.receive({ type: 'delta', key: 'selection', delta: '藏起了钥匙' });
    expect(text.textContent).toBe('蓝狐狸藏起了钥匙');
    port.receive({ type: 'done', key: 'selection', text: '蓝狐狸藏起了一把黄铜钥匙。' });
    expect(panel.getAttribute('aria-busy')).toBe('true');
    port.receive({ type: 'finished' });
    await vi.waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'));
    expect(text.textContent).toBe('蓝狐狸藏起了一把黄铜钥匙。');
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects a dismissed stream and ignores stale output', async () => {
    const oldPort = mockPort();
    const newPort = mockPort();
    const connect = vi.fn().mockReturnValueOnce(oldPort).mockReturnValueOnce(newPort);
    vi.stubGlobal('chrome', { runtime: { connect } });
    selection.setStreamingTarget('zh-CN');

    selection.translateCurrentSelection();
    const { close, panel, text } = selectionPanel();
    close.click();
    expect(panel.style.display).toBe('none');
    expect(oldPort.disconnect).toHaveBeenCalledOnce();
    selection.translateCurrentSelection();
    oldPort.receive({ type: 'delta', key: 'selection', delta: '旧结果' });
    expect(text.textContent).toBe('翻译中…');
    newPort.receive({ type: 'done', key: 'selection', text: '新结果' });
    newPort.receive({ type: 'finished' });
    await vi.waitFor(() => expect(text.textContent).toBe('新结果'));
  });

  it('renders a terminal error when the port disconnects before a final result', async () => {
    const port = mockPort();
    vi.stubGlobal('chrome', { runtime: { connect: () => port } });
    selection.setStreamingTarget('zh-CN');

    selection.translateCurrentSelection();
    const { panel, text } = selectionPanel();
    port.receive({ type: 'delta', key: 'selection', delta: '蓝狐狸' });
    port.drop();
    await vi.waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'));
    expect(text.textContent).toBe('翻译失败：流式连接中断');
    expect(text.classList.contains('error')).toBe(true);
  });

  it('preserves the one-shot path when streaming is disabled', async () => {
    const sendMessage = vi.fn((_message: unknown, reply: (response: unknown) => void) => {
      reply({ ok: true, translated: '蓝狐狸藏起了一把黄铜钥匙。', language: 'zh-CN' });
    });
    const connect = vi.fn();
    vi.stubGlobal('chrome', { runtime: { connect, sendMessage } });
    selection.setStreamingTarget('zh-CN');
    selection.setStreamingTarget(null);

    selection.translateCurrentSelection();
    const { panel, text } = selectionPanel();
    await vi.waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'));
    expect(connect).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-selection', text: source }), expect.any(Function));
    expect(text.textContent).toBe('蓝狐狸藏起了一把黄铜钥匙。');
  });
});
