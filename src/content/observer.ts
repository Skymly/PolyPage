/**
 * MutationObserver for dynamically added content (spec §10.2 item 8).
 * Debounced: bursts of DOM changes trigger a single rescan afterwards.
 * Mutations caused by our own inserted nodes are ignored.
 */
const DEBOUNCE_MS = 800;

export class DomObserver {
  private mo: MutationObserver | null = null;
  private timer: number | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly isOwnNode: (node: Node) => boolean,
  ) {}

  start(): void {
    if (this.mo || !document.body) return;
    this.mo = new MutationObserver((mutations) => {
      const meaningful = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (n) => n.nodeType === Node.ELEMENT_NODE && !this.isOwnNode(n),
        ),
      );
      if (meaningful) this.schedule();
    });
    this.mo.observe(document.body, { childList: true, subtree: true });
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  stop(): void {
    this.mo?.disconnect();
    this.mo = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
