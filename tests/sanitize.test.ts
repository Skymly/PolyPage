/**
 * Output hygiene unit tests (spec 4.2 §5.2 / §12.1).
 */
import { describe, expect, it } from 'vitest';
import {
  createThinkDeltaFilter,
  minimaxHostHint,
  sanitizeTranslation,
  stripThinkTags,
} from '../src/shared/sanitize';

describe('stripThinkTags', () => {
  it('removes paired think blocks case-insensitively', () => {
    expect(stripThinkTags('<THINK>secret plan</THINK>开源软件改变了世界。')).toBe(
      '开源软件改变了世界。',
    );
  });

  it('treats unclosed think as running to end-of-string when holding', () => {
    expect(stripThinkTags('<think>I will reason forever', { holdUnclosed: true }).trim()).toBe('');
  });

  it('does not swallow the rest of a translation after an unclosed think tag (M-79)', () => {
    expect(stripThinkTags('请加上 <think> 再试')).toBe('请加上  再试');
  });

  it('keeps same-line text around a leftover close tag (M-79)', () => {
    expect(stripThinkTags('请输出</think>结束')).toBe('请输出结束');
  });

  it('drops a leftover qwen3 </think> prefix', () => {
    const raw = `The user wants a translation of a sentence.
I should output only Chinese.
</think>
开源软件改变了世界。`;
    expect(stripThinkTags(raw).trim()).toBe('开源软件改变了世界。');
  });

  it('does not touch a legal sentence that merely mentions think', () => {
    const legal = 'I think this library is ready for review.';
    expect(stripThinkTags(legal)).toBe(legal);
  });
});

describe('sanitizeTranslation', () => {
  it('strips qwen3 residue and trims', () => {
    const result = sanitizeTranslation('</think>\n  开源软件改变了世界。  ');
    expect(result).toEqual({ ok: true, text: '开源软件改变了世界。' });
  });

  it('optionally unwraps MiniMax fenced JSON after think tags', () => {
    const raw = `<think>ok</think>
\`\`\`json
[{"text":"HELLO WORLD","translation":"你好世界"}]
\`\`\``;
    const kept = sanitizeTranslation(raw, { stripCodeFences: false });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.text).toContain('HELLO WORLD');

    const stripped = sanitizeTranslation(raw, { stripCodeFences: true });
    expect(stripped).toEqual({
      ok: true,
      text: '[{"text":"HELLO WORLD","translation":"你好世界"}]',
    });
  });

  it('treats think-only output as empty / invalid_response', () => {
    expect(sanitizeTranslation('<think>only reasoning</think>')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(sanitizeTranslation('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('leaves raw model output untouched when disabled', () => {
    const raw = '<think>debug me</think>hello';
    expect(sanitizeTranslation(raw, { enabled: false })).toEqual({
      ok: true,
      text: raw,
      persist: false,
    });
  });
});

describe('minimaxHostHint', () => {
  it('warns when a Token Plan key is aimed at api.minimax.io', () => {
    const hint = minimaxHostHint('https://api.minimax.io/v1', 'sk-cp-not-a-real-key');
    expect(hint).toContain('api.minimax.chat');
    expect(hint).not.toContain('sk-cp-');
  });

  it('is silent for the correct Token Plan host', () => {
    expect(minimaxHostHint('https://api.minimax.chat/v1', 'sk-cp-not-a-real-key')).toBeNull();
    expect(minimaxHostHint('https://api.minimax.io/v1', 'sk-other')).toBeNull();
  });

  it('does not match minimax.io as a substring (M-78)', () => {
    expect(minimaxHostHint('https://api.minimax.io.evil.com/v1', 'sk-cp-not-a-real-key')).toBeNull();
    expect(minimaxHostHint('https://minimax.iot.example.com/v1', 'sk-cp-not-a-real-key')).toBeNull();
  });
});

describe('createThinkDeltaFilter (M-60)', () => {
  it('holds back unclosed think and emits the visible suffix after close', () => {
    const filter = createThinkDeltaFilter();
    expect(filter('<think>secret')).toBe('');
    expect(filter(' more')).toBe('');
    expect(filter('</think>开源')).toBe('开源');
  });

  it('forwards plain text immediately', () => {
    const filter = createThinkDeltaFilter();
    expect(filter('hello ')).toBe('hello ');
    expect(filter('world')).toBe('world');
  });
});
