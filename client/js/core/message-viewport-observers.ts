/** One observer pair and delegated interaction listener set per scroll owner.
 * Message models remain in AppState; only live DOM nodes/callbacks are held.
 */
interface RowCallbacks {
  visibility(near: boolean): void;
  size(height: number): void;
  interaction(type: string): void;
}
interface RowPool {
  add(node: HTMLElement, callbacks: RowCallbacks): () => void;
}
const pools = new WeakMap<Element, RowPool>();
const events = ['bridge:message-reveal', 'focusin', 'focusout', 'play', 'pause', 'ended'] as const;

export function observeMessageRow(node: HTMLElement, callbacks: RowCallbacks): () => void {
  const root = node.closest('#messages-area') ?? node.ownerDocument.documentElement;
  let pool = pools.get(root);
  if (!pool) {
    const rows = new Map<HTMLElement, RowCallbacks>();
    const visibility = new IntersectionObserver(entries => {
      for (const entry of entries) rows.get(entry.target as HTMLElement)?.visibility(entry.isIntersecting);
    }, { root, rootMargin: '600px 0px' });
    const sizes = new ResizeObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const row = rows.get(target);
        if (!row) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? target.getBoundingClientRect().height;
        if (Number.isFinite(height) && height > 0) row.size(height);
      }
    });
    const interaction = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const node = event.target.closest<HTMLElement>('[data-message-viewport-id]');
      if (node) rows.get(node)?.interaction(event.type);
    };
    for (const type of events) root.addEventListener(type, interaction, true);
    pool = {
      add(node, callbacks) {
        rows.set(node, callbacks); sizes.observe(node); visibility.observe(node);
        let alive = true;
        return () => {
          if (!alive) return;
          alive = false; rows.delete(node); sizes.unobserve(node); visibility.unobserve(node);
          if (rows.size === 0) {
            sizes.disconnect(); visibility.disconnect();
            for (const type of events) root.removeEventListener(type, interaction, true);
            pools.delete(root);
          }
        };
      },
    };
    pools.set(root, pool);
  }
  return pool.add(node, callbacks);
}
