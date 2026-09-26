export interface FloatingRectInput {
  left: number;
  top: number;
  width: number;
  height: number;
  margin?: number;
}

export interface FloatingPoint {
  left: number;
  top: number;
}

/**
 * Keep a floating menu/popover inside the *visual* viewport.
 *
 * `innerWidth/innerHeight` describe the layout viewport and can be larger than
 * the actually visible area while a mobile keyboard or pinch zoom is active.
 * Prefer visualViewport when available, then fail safely to layout viewport.
 */
export function clampFloatingRect(input: FloatingRectInput): FloatingPoint {
  const margin = Math.max(0, Number.isFinite(input.margin) ? input.margin! : 8);
  const visual = typeof window !== 'undefined' ? window.visualViewport : null;
  const viewportLeft = visual?.offsetLeft ?? 0;
  const viewportTop = visual?.offsetTop ?? 0;
  const viewportWidth = visual?.width ?? (typeof window !== 'undefined' ? window.innerWidth : input.width + margin * 2);
  const viewportHeight = visual?.height ?? (typeof window !== 'undefined' ? window.innerHeight : input.height + margin * 2);

  const minLeft = viewportLeft + margin;
  const minTop = viewportTop + margin;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - input.width - margin);
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - input.height - margin);

  return {
    left: Math.min(Math.max(input.left, minLeft), maxLeft),
    top: Math.min(Math.max(input.top, minTop), maxTop),
  };
}
