import { describe, expect, it, vi } from 'vitest';
import {
  selectSocialWebGLContext, socialRoomShaderSources, socialRoomRenderSize,
  SOCIAL_GRAPHICS_QUALITY,
} from '../js/core/activities/social-room-render-policy.ts';

describe('3D Social Space GPU context negotiation and real buffer caps', () => {
  it('prefers WebGL 2 and never requests WebGL 1 when modern context is available', () => {
    const context2 = { type: 'webgl2' };
    const getContext = vi.fn((_id: string) => context2);
    const picked = selectSocialWebGLContext({ getContext } as unknown as HTMLCanvasElement);
    expect(picked).toEqual({ gl: context2, api: 'webgl2' });
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({
      alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false,
    }));
  });

  it('falls back to WebGL 1 when WebGL 2 returns null', () => {
    const gl1 = { type: 'webgl1' };
    const getContext = vi.fn((name: string) => name === 'webgl2' ? null : gl1);
    const picked = selectSocialWebGLContext({ getContext } as unknown as HTMLCanvasElement);
    expect(picked).toEqual({ gl: gl1, api: 'webgl1' });
    expect(getContext.mock.calls.map(args => args[0])).toEqual(['webgl2', 'webgl']);
  });

  it('falls back when old mobile WebView throws on the WebGL 2 API', () => {
    const gl1 = { type: 'webgl1' };
    const getContext = vi.fn((name: string) => {
      if (name === 'webgl2') throw new Error('unsupported context');
      return gl1;
    });
    expect(selectSocialWebGLContext({ getContext } as unknown as HTMLCanvasElement))
      .toEqual({ gl: gl1, api: 'webgl1' });
  });

  it('reports no compatible graphics context instead of inventing one', () => {
    const getContext = vi.fn(() => null);
    expect(selectSocialWebGLContext({ getContext } as unknown as HTMLCanvasElement)).toBeNull();
    expect(getContext).toHaveBeenCalledTimes(2);
    const throws = vi.fn(() => { throw new Error('WebGL disabled'); });
    expect(selectSocialWebGLContext({ getContext: throws } as unknown as HTMLCanvasElement)).toBeNull();
  });

  it('selects GLSL ES 3.00 shaders for WebGL 2 and ES 1.00 for WebGL 1', () => {
    const modern = socialRoomShaderSources('webgl2');
    const fallback = socialRoomShaderSources('webgl1');
    expect(modern.vertex.startsWith('#version 300 es\n')).toBe(true);
    expect(modern.fragment.startsWith('#version 300 es\n')).toBe(true);
    expect(modern.vertex).toContain('in vec3 aPosition;');
    expect(modern.fragment).toContain('out vec4 fragColor;');
    expect(modern.fragment).not.toContain('gl_FragColor');
    expect(fallback.vertex).toContain('attribute vec3 aPosition;');
    expect(fallback.vertex).not.toContain('#version 300 es');
    expect(fallback.fragment).toContain('gl_FragColor');
    expect(fallback.fragment).not.toContain('out vec4 fragColor;');
  });

  it('keeps low-quality mobile output at <=1 million pixels and 24 FPS target', () => {
    const size = socialRoomRenderSize(2400, 1600, 4, 'low');
    expect(size.width * size.height).toBeLessThanOrEqual(1_000_000);
    expect(size.dpr).toBeLessThanOrEqual(1);
    expect(size.targetFps).toBe(24);
  });

  it('caps retina-balanced framebuffer growth and preserves aspect ratio approximately', () => {
    const size = socialRoomRenderSize(2160, 1440, 5, 'balanced');
    expect(size.width * size.height).toBeLessThanOrEqual(2_073_600);
    expect(size.dpr).toBeLessThanOrEqual(1.5);
    expect(size.targetFps).toBe(30);
    expect(size.width / size.height).toBeCloseTo(2160 / 1440, 2);
  });

  it('allows high-quality 60 FPS target but still caps memory-heavy framebuffers', () => {
    const size = socialRoomRenderSize(3840, 2160, 5, 'high');
    expect(size.width * size.height).toBeLessThanOrEqual(4_147_200);
    expect(size.dpr).toBeLessThanOrEqual(2);
    expect(size.targetFps).toBe(60);
    expect(SOCIAL_GRAPHICS_QUALITY.high.targetFps).toBeGreaterThan(
      SOCIAL_GRAPHICS_QUALITY.low.targetFps,
    );
  });

  it('rejects invalid policies and prevents NaN/Infinity buffer dimensions', () => {
    const safe = socialRoomRenderSize(Infinity, NaN, Infinity, 'balanced');
    expect(safe.width).toBe(1);
    expect(safe.height).toBe(1);
    expect(safe.dpr).toBe(1);
    const negative = socialRoomRenderSize(-500, -2, -1, 'low');
    expect(negative).toMatchObject({ width: 1, height: 1 });
    expect(() => socialRoomRenderSize(10, 10, 1, 'ultra' as never)).toThrow(RangeError);
  });
});
