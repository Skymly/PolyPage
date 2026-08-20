/**
 * Internal node state for 网页翻译. Not part of the module interface.
 */
import type { NodeStatus } from '../shared/types';

export interface InlineSegmentState {
  key: string;
  text: string;
  dstEl: HTMLElement | null;
  status: NodeStatus;
  translated: string | null;
  error: string | null;
}

export interface NodeEntry {
  id: string;
  el: HTMLElement;
  originalText: string;
  textHash: string;
  originalNodes: ChildNode[] | null;
  translated: string | null;
  status: NodeStatus;
  error: string | null;
  bilingualEl: HTMLElement | null;
  inlineSegments: InlineSegmentState[] | null;
  inlineDegraded: boolean;
  visible: boolean;
}