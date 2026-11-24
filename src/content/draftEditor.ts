/** Draft snapshots retain the user's selection and the specific text nodes that may change.
 * Quotes, Markdown code and rich formatting stay in the editor throughout the request. */
export type DraftEditor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type Field = HTMLInputElement | HTMLTextAreaElement;

function isField(el: HTMLElement): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

export function draftEditor(target: EventTarget | null): DraftEditor | null {
  if (!(target instanceof HTMLElement)) return null;
  if (isField(target)) {
    if (target.disabled || target.readOnly) return null;
    if (target instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(target.type)) return null;
    return target;
  }
  if (!target.isContentEditable) return null;
  let host = target;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

interface Edit {
  node?: Text;
  start: number;
  end: number;
  source: string;
}

/** Clip after parsing the whole source so selecting inside a quote or fence never unprotects it. */
export function proseEdits(value: string, from = 0, to = value.length): Edit[] {
  const edits: Edit[] = [];
  function add(start: number, end: number): void {
    const left = Math.max(from, start);
    const part = value.slice(left, Math.max(left, Math.min(to, end)));
    const source = part.trim();
    if (source) {
      const pos = left + part.length - part.trimStart().length;
      edits.push({ start: pos, end: pos + source.length, source });
    }
  }
  let offset = 0;
  let fence = '';
  for (const line of value.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = '';
    } else if (marker) {
      fence = marker;
    } else if (!/^\s*>|^(?: {4}|\t)/u.test(line)) {
      let next = 0;
      for (const code of line.matchAll(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/gu)) {
        add(offset + next, offset + code.index);
        next = code.index + code[0].length;
      }
      add(offset + next, offset + line.length);
    }
    offset += line.length + 1;
  }
  return edits;
}

interface SelectionPoint { node: Node; offset: number }
export interface DraftSnapshot {
  editor: DraftEditor;
  value: string;
  edits: Edit[];
  selected: boolean;
  fieldSelection?: { start: number; end: number; direction: 'forward' | 'backward' | 'none' };
  richSelection?: { anchor: SelectionPoint; focus: SelectionPoint };
  /** Literal runs include surrounding rich text and references into edits. */
  richPreview?: Array<string | number>;
}

export function snapshotDraft(editor: DraftEditor): DraftSnapshot {
  if (isField(editor)) {
    const start = editor.selectionStart ?? 0;
    const end = editor.selectionEnd ?? 0;
    const selected = end > start;
    return {
      editor, value: editor.value, selected,
      edits: proseEdits(editor.value, selected ? start : 0, selected ? end : editor.value.length),
      fieldSelection: { start, end, direction: editor.selectionDirection ?? 'none' },
    };
  }

  const sel = editor.ownerDocument.getSelection();
  const range = editor.ownerDocument.createRange();
  const richPreview: Array<string | number> = [];
  let richSelection: DraftSnapshot['richSelection'];
  let selected = false;
  if (sel?.rangeCount && sel.anchorNode && sel.focusNode &&
      editor.contains(sel.anchorNode) && editor.contains(sel.focusNode)) {
    richSelection = {
      anchor: { node: sel.anchorNode, offset: sel.anchorOffset },
      focus: { node: sel.focusNode, offset: sel.focusOffset },
    };
    selected = !sel.isCollapsed;
  }
  if (selected && sel) {
    const r = sel.getRangeAt(0);
    range.setStart(r.startContainer, r.startOffset);
    range.setEnd(r.endContainer, r.endOffset);
  } else {
    if (sel?.rangeCount && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(editor)) {
      return { editor, value: editor.innerHTML, selected: true, edits: [] };
    }
    range.selectNodeContents(editor);
  }
  const edits: Edit[] = [];
  const walker = editor.ownerDocument.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node instanceof HTMLBRElement) richPreview.push('\n');
    if (!(node instanceof Text) || node.parentElement?.closest('[hidden], script, style')) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.length;
    const block = node.parentElement?.closest('p, div, pre, blockquote, li, h1, h2, h3') ?? null;
    if (previousBlock && block !== previousBlock) richPreview.push('\n');
    previousBlock = block;
    let pos = from;
    if (!node.parentElement?.closest('blockquote, pre, code, [contenteditable="false"]')) {
      for (const edit of proseEdits(node.data, from, to)) {
        richPreview.push(node.data.slice(pos, edit.start), edits.length);
        edits.push({ ...edit, node });
        pos = edit.end;
      }
    }
    richPreview.push(node.data.slice(pos, to));
  }
  return { editor, value: editor.innerHTML, selected, edits, richSelection, richPreview };
}

function editorValue(editor: DraftEditor): string {
  return isField(editor) ? editor.value : editor.innerHTML;
}

export function draftIntact(snap: DraftSnapshot, expected = snap.value, edits = snap.edits): boolean {
  return snap.editor.isConnected && draftEditor(snap.editor) === snap.editor &&
    editorValue(snap.editor) === expected && edits.every(e => !e.node ||
      (snap.editor.contains(e.node) && e.node.data.slice(e.start, e.end) === e.source));
}

export function draftPreview(snap: DraftSnapshot, results: string[]): string {
  if (snap.richPreview) return snap.richPreview.map(p => typeof p === 'number' ? results[p] : p).join('');
  let value = snap.value;
  for (let i = snap.edits.length - 1; i >= 0; i--) {
    const { start, end } = snap.edits[i];
    value = value.slice(0, start) + results[i] + value.slice(end);
  }
  if (!snap.selected || !snap.fieldSelection) return value;
  const { start, end } = snap.fieldSelection;
  return value.slice(start, value.length - (snap.value.length - end));
}

function notifyBefore(editor: DraftEditor, inputType: string): boolean {
  return editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, composed: true, cancelable: true, inputType,
  }));
}

function notifyInput(editor: DraftEditor, inputType: string): void {
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType }));
}

/** All validation precedes the first write. A framework can veto beforeinput or update the draft synchronously. */
export function applyDraft(snap: DraftSnapshot, results: string[]): (() => boolean) | null {
  const { editor, edits } = snap;
  if (!edits.length || results.length !== edits.length || results.some(s => !s.trim()) || !draftIntact(snap)) return null;
  if (!notifyBefore(editor, 'insertReplacementText') || !draftIntact(snap)) return null;
  const inverse: Edit[] = [];
  let delta = 0;
  for (let i = 0; i < edits.length; i++) {
    if (i && edits[i].node !== edits[i - 1].node) delta = 0;
    const start = edits[i].start + delta;
    inverse.push({ ...edits[i], start, end: start + results[i].length, source: results[i] });
    delta += results[i].length - edits[i].source.length;
  }
  const write = (plan: Edit[], texts: string[]): void => {
    for (let i = plan.length - 1; i >= 0; i--) {
      const { node, start, end } = plan[i];
      if (isField(editor)) editor.setRangeText(texts[i], start, end, 'preserve');
      else node!.replaceData(start, end - start, texts[i]);
    }
  };

  editor.focus({ preventScroll: true });
  if (!draftIntact(snap)) return null;
  write(edits, results);
  const last = inverse[inverse.length - 1];
  if (isField(editor)) editor.setSelectionRange(last.end, last.end);
  else if (last.node) editor.ownerDocument.getSelection()?.collapse(last.node, last.end);
  const applied = editorValue(editor);
  notifyInput(editor, 'insertReplacementText');
  return () => {
    if (!draftIntact(snap, applied, inverse) || !notifyBefore(editor, 'historyUndo')) return false;
    editor.focus({ preventScroll: true });
    if (!draftIntact(snap, applied, inverse)) return false;
    write(inverse, edits.map(e => e.source));
    if (isField(editor) && snap.fieldSelection) {
      const { start, end, direction } = snap.fieldSelection;
      editor.setSelectionRange(start, end, direction);
    } else if (snap.richSelection) {
      const { anchor, focus } = snap.richSelection;
      if (editor.contains(anchor.node) && editor.contains(focus.node)) {
        editor.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      }
    }
    notifyInput(editor, 'historyUndo');
    return true;
  };
}
