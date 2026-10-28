// JS-side diagnostic markers only: these are NOT Android TTID/TTFD or iOS launch metrics.
// No account IDs, session tokens, URLs, message bodies, or device identifiers are captured.
const MARKS = new Set(['js_entry', 'first_layout', 'first_interaction']);

export function createStartupMetrics(clock = () => performance.now()) {
  const origin = clock();
  if (!Number.isFinite(origin)) throw new TypeError('non-finite clock origin');
  const marks = new Map();
  let last = 0;
  return {
    mark(name) {
      if (!MARKS.has(name)) throw new TypeError('unapproved startup marker');
      if (marks.has(name)) return false;
      const elapsed = clock() - origin;
      if (!Number.isFinite(elapsed) || elapsed < last || elapsed < 0) {
        throw new RangeError('startup clock must be monotonic');
      }
      marks.set(name, Math.round(elapsed * 10) / 10);
      last = elapsed;
      return true;
    },
    snapshot() {
      return Object.fromEntries(marks);
    },
  };
}
