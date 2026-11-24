// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDraft, draftEditor, draftPreview, proseEdits, snapshotDraft } from '../src/content/draftEditor';

afterEach(() => document.body.replaceChildren());

function field(value: string) {
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.value = value;
  return editor;
}

describe('draft editing', () => {
  it('protects complete Markdown quotes, inline code and fenced blocks even given a partial selection', () => {
    const draft = '> 原话\n正文 `status()` 下一句\n~~~js\nfoo();\n~~~\n\n结尾';
    expect(proseEdits(draft).map(e => e.source)).toEqual(['正文', '下一句', '结尾']);
    expect(proseEdits(draft, 2, 4)).toEqual([]);
    const middle = draft.indexOf('foo');
    expect(proseEdits(draft, middle, middle + 2)).toEqual([]);
  });
  it('preserves framing, previews before replacing, and undoes to the original selection', () => {
    const editor = field('原文\n  修复了 `main()` 的问题  \n谢谢');
    const from = editor.value.indexOf('修');
    const to = editor.value.indexOf('题') + 1;
    editor.setSelectionRange(from, to, 'backward');
    const snap = snapshotDraft(editor);
    expect(draftPreview(snap, ['Fixed', 'issue'])).toBe('Fixed `main()` issue');
    expect(editor.value).toBe(snap.value);
    const input = vi.fn();
    editor.addEventListener('input', input);
    const undo = applyDraft(snap, ['Fixed', 'issue']);
    expect(editor.value).toBe('原文\n  Fixed `main()` issue  \n谢谢');
    expect(undo?.()).toBe(true);
    expect(editor.value).toBe(snap.value);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([from, to, 'backward']);
    expect(input).toHaveBeenCalledTimes(2);
  });
  it('refuses stale results and stale undo even after a silent programmatic value change', () => {
    const editor = field('初稿');
    const stale = snapshotDraft(editor);
    editor.value = '最新草稿';
    expect(applyDraft(stale, ['stale'])).toBeNull();
    const undo = applyDraft(snapshotDraft(editor), ['Latest draft']);
    editor.value += '!';
    expect(undo?.()).toBe(false);
    expect(editor.value).toBe('Latest draft!');
  });
  it('respects a synchronous editor veto before writing and rechecks after beforeinput', () => {
    const editor = field('回复');
    const snap = snapshotDraft(editor);
    editor.addEventListener('beforeinput', e => e.preventDefault(), { once: true });
    expect(applyDraft(snap, ['Reply'])).toBeNull();
    editor.addEventListener('beforeinput', () => { editor.value = '框架修订'; }, { once: true });
    expect(applyDraft(snap, ['Reply'])).toBeNull();
    expect(editor.value).toBe('框架修订');
  });
  it('excludes password, read-only and disabled fields', () => {
    const input = document.createElement('input');
    input.type = 'password';
    expect(draftEditor(input)).toBeNull();
    input.type = 'text';
    expect(draftEditor(input)).toBe(input);
    input.readOnly = true;
    expect(draftEditor(input)).toBeNull();
    input.readOnly = false;
    input.disabled = true;
    expect(draftEditor(input)).toBeNull();
  });
});
