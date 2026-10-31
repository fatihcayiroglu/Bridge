/**
 * Graphics policy for Bridge's independent 3D Social Space prototype.
 *
 * WebGL 2 first for a modern shader path, WebGL 1 when unavailable. WebGPU is
 * intentionally not assumed: mobile WebViews and native shells vary widely.
 * No timers, device profiling, tracking or network access.
 */
export type SocialGraphicsApi = 'webgl2' | 'webgl1';
export type SocialGraphicsQuality = 'low' | 'balanced' | 'high';

export interface SocialGraphicsContext {
  readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  readonly api: SocialGraphicsApi;
}
export interface SocialRenderSize {
  readonly width: number;
  readonly height: number;
  readonly targetFps: number;
  readonly dpr: number;
}
export const SOCIAL_GRAPHICS_QUALITY: Readonly<Record<SocialGraphicsQuality, {
  readonly pixelRatioCap: number;
  readonly targetFps: number;
  readonly maxPixelArea: number;
}>> = Object.freeze({
  low: Object.freeze({ pixelRatioCap: 1, targetFps: 24, maxPixelArea: 1_000_000 }),
  balanced: Object.freeze({ pixelRatioCap: 1.5, targetFps: 30, maxPixelArea: 2_073_600 }),
  high: Object.freeze({ pixelRatioCap: 2, targetFps: 60, maxPixelArea: 4_147_200 }),
});

export function selectSocialWebGLContext(canvas: HTMLCanvasElement): SocialGraphicsContext | null {
  const attrs: WebGLContextAttributes = {
    alpha: false,
    antialias: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  };
  // Some older WebViews throw rather than return null for an unsupported API.
  try {
    const gl2 = canvas.getContext('webgl2', attrs);
    if (gl2) return { gl: gl2, api: 'webgl2' };
  } catch { /* Fall back to WebGL 1; never claim a context exists on failure. */ }
  try {
    const gl1 = canvas.getContext('webgl', attrs);
    if (gl1) return { gl: gl1, api: 'webgl1' };
  } catch { /* No compatible graphics API. */ }
  return null;
}

/** Explicit matching GLSL versions; WebGL 2 uses GLSL ES 3.00, WebGL 1 uses ES 1.00. */
export function socialRoomShaderSources(api: SocialGraphicsApi): {
  vertex: string;
  fragment: string;
} {
  if (api === 'webgl2') {
    return {
      vertex: [
        '#version 300 es',
        'in vec3 aPosition;', 'in vec3 aColor;',
        'uniform mat4 uProjection;', 'uniform mat4 uView;',
        'out vec3 vColor;',
        'void main() { vColor = aColor; gl_Position = uProjection * uView * vec4(aPosition, 1.0); }',
      ].join('\n'),
      fragment: [
        '#version 300 es',
        'precision mediump float;', 'in vec3 vColor;',
        'out vec4 fragColor;',
        'void main() { fragColor = vec4(vColor, 1.0); }',
      ].join('\n'),
    };
  }
  return {
    vertex: [
      'attribute vec3 aPosition;', 'attribute vec3 aColor;',
      'uniform mat4 uProjection;', 'uniform mat4 uView;', 'varying vec3 vColor;',
      'void main() { vColor = aColor; gl_Position = uProjection * uView * vec4(aPosition, 1.0); }',
    ].join('\n'),
    fragment: [
      'precision mediump float;', 'varying vec3 vColor;',
      'void main() { gl_FragColor = vec4(vColor, 1.0); }',
    ].join('\n'),
  };
}

/**
 * Cap both device pixel ratio and total framebuffer area. A giant WebView or
 * inflated DPR must not allocate unbounded GPU memory on mobile.
 */
export function socialRoomRenderSize(
  widthCss: number,
  heightCss: number,
  devicePixelRatio: number,
  quality: SocialGraphicsQuality,
): SocialRenderSize {
  const policy = SOCIAL_GRAPHICS_QUALITY[quality];
  if (!policy) throw new RangeError('Invalid social graphics quality');
  const safeWidth = Number.isFinite(widthCss) ? Math.max(1, Math.min(8192, widthCss)) : 1;
  const safeHeight = Number.isFinite(heightCss) ? Math.max(1, Math.min(8192, heightCss)) : 1;
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.max(0.5, Math.min(devicePixelRatio, policy.pixelRatioCap)) : 1;
  const requestedArea = safeWidth * safeHeight * safeDpr * safeDpr;
  const areaScale = requestedArea > policy.maxPixelArea
    ? Math.sqrt(policy.maxPixelArea / requestedArea) : 1;
  const dpr = safeDpr * areaScale;
  return {
    width: Math.max(1, Math.floor(safeWidth * dpr)),
    height: Math.max(1, Math.floor(safeHeight * dpr)),
    targetFps: policy.targetFps,
    dpr,
  };
}
