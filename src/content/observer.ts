/**
 * MutationObserver for dynamically added content (spec §10.2 item 8),
 * evolved for 2.0: shadow roots are observed too (spec 2.0 §6.1), and
 * characterData changes are surfaced so the translator can detect
 * recycled virtual-list nodes (spec 2.0 §6.3).
 */
const DEBOUNCE_MS = 800;

export class DomObserver {
  private observers: MutationObserver[] = [];
  private roots = new Set<Node>();
  private timer: number | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly isOwnNode: (node: Node) => boolean,
  ) {}

  start(): void {
    if (document.body) this.observeRoot(document.body);
  }

  /** Observe a root (document.body or a shadow root) exactly once. */
  observeRoot(root: Node): void {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    const mo = new MutationObserver((mutations) => {
      let meaningful = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of Array.from(m.addedNodes)) {
            if (n.nodeType === Node.ELEMENT_NODE && !this.isOwnNode(n)) {
              meaningful = true;
              break;
            }
          }
        } else if (m.type === 'characterData') {
          if (m.target && !this.isOwnNode(m.target)) meaningful = true;
        }
        if (meaningful) break;
      }
      if (meaningful) this.schedule();
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    this.observers.push(mo);
    // Pick up shadow roots that already exist under this root.
    this.scanForShadowRoots(root);
  }

  /** Attach observers to any open shadow roots beneath a node. */
  scanForShadowRoots(node: Node): void {
    if (!(node instanceof Element) && !(node instanceof Document)) return;
    const elements = (node as Element | Document).querySelectorAll?.('*') ?? [];
    for (const el of Array.from(elements)) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) this.observeRoot(shadow);
    }
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  stop(): void {
    for (const mo of this.observers) mo.disconnect();
    this.observers = [];
    this.roots.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}