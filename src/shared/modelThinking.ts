import { isMinimaxApiHost } from './sanitize';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ThinkingLevel = ReasoningEffort | 'enabled';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return value === 'enabled' || isReasoningEffort(value) ? value : undefined;
}

const MINIMAX_THINKING_TOGGLE = ['none', 'enabled'] as const;
const MINIMAX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function minimaxThinkingLevels(baseUrl: string, model: string): readonly ThinkingLevel[] | undefined {
  if (!isMinimaxApiHost(baseUrl)) return undefined;
  return /^minimax-m3\.1-flash(?:-|$)/i.test(model.trim()) ? MINIMAX_REASONING_EFFORTS : MINIMAX_THINKING_TOGGLE;
}
