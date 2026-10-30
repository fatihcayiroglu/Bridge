import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMiniGolfPractice } from '../js/core/activities/mini-golf-webgl.ts';
import { startPoolPractice } from '../js/core/activities/pool-practice-webgl.ts';
import { startLocalSocialRoom } from '../js/core/activities/social-room-webgl.ts';

function fakeGl() {
  const gl = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713,
    LINK_STATUS: 35714, ARRAY_BUFFER: 34962, STATIC_DRAW: 35044,
    DYNAMIC_DRAW: 35048, DEPTH_TEST: 2929, BLEND: 3042, FLOAT: 5126,
    TRIANGLES: 4, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    createShader: vi.fn(() => ({} as WebGLShader)),
    shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({} as WebGLProgram)),
    attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({} as WebGLBuffer)),
    bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    useProgram: vi.fn(), getAttribLocation: vi.fn(() => 1),
    getUniformLocation: vi.fn(() => ({} as WebGLUniformLocation)),
    enableVertexAttribArray: vi.fn(), disableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(), drawArrays: vi.fn(),
    enable: vi.fn(), disable: vi.fn(), viewport: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), uniformMatrix4fv: vi.fn(),
  };
  return gl;
}
let nextId = 1;
let now = 0;
let pending: Map<number, FrameRequestCallback>;
function frames(count: number) {
  for (let i = 0; i < count; i++) {
    const callbacks = [...pending.values()];
    pending.clear();
    now += 1000 / 60;
    callbacks.forEach(callback => callback(now));
  }
}
function surface(api: 'webgl1' | 'webgl2' | 'none' = 'webgl2') {
  const gl = fakeGl();
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'getContext', {
    configurable: true, value: (kind: string) => {
      if (api === 'none') return null;
      return kind === (api === 'webgl2' ? 'webgl2' : 'webgl') ? gl : null;
    },
  });
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true, value: () => ({ width: 650, height: 460, top: 0, left: 0, right: 650, bottom: 460 }),
  });
  document.body.append(canvas);
  return { canvas, gl };
}
beforeEach(() => {
  document.body.replaceChildren();
  nextId = 1;
  now = 0;
  pending = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id); });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'hidden');
  vi.unstubAllGlobals();
});

describe('real renderer lifecycle against a deterministic WebGL command recorder (separate real Chromium E2E)', () => {
  it('Pool renders table, all visible spheres and a shot with a bounded framebuffer; dispose frees resources', () => {
    const { canvas, gl } = surface();
    const updates: string[] = [];
    const handle = startPoolPractice(canvas, state => updates.push(state.status));
    expect(handle).not.toBeNull();
    expect(handle?.isGraphicsAvailable).toBe(true);
    frames(3);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
    expect(gl.drawArrays).toHaveBeenCalled();
    expect(gl.bufferData).toHaveBeenCalled();
    expect(handle?.shoot(0, 60)).toBe(true);
    expect(handle?.state.shots).toBe(1);
    expect(handle?.shoot(0, 60)).toBe(false);
    frames(45);
    expect(updates).toContain('moving');
    handle?.reset();
    expect(handle?.state.shots).toBe(0);
    handle?.dispose();
    expect(handle?.isGraphicsAvailable).toBe(false);
    expect(pending.size).toBe(0);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    handle?.dispose();
  });
  it('Pool fails closed on lost context and only resumes after explicit GPU recovery', () => {
    const { canvas, gl } = surface('webgl1');
    const lost = vi.fn(), restored = vi.fn();
    const handle = startPoolPractice(canvas, vi.fn(), lost, restored);
    frames(2);
    const invalidation = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(invalidation);
    expect(invalidation.defaultPrevented).toBe(true);
    expect(lost).toHaveBeenCalledOnce();
    expect(handle?.isGraphicsAvailable).toBe(false);
    expect(handle?.shoot(0, 70)).toBe(false);
    expect(pending.size).toBe(0);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(restored).toHaveBeenCalledOnce();
    expect(handle?.isGraphicsAvailable).toBe(true);
    frames(3);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    handle?.dispose();
  });
  it('Pool refuses unsupported graphics and disposes partially allocated resources on link failure', () => {
    const none = surface('none');
    expect(startPoolPractice(none.canvas, vi.fn())).toBeNull();
    const { canvas, gl } = surface();
    gl.getProgramParameter.mockReturnValueOnce(false);
    expect(() => startPoolPractice(canvas, vi.fn())).toThrow('POOL_PROGRAM');
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(pending.size).toBe(0);
  });
  it('Mini Golf renders, shoots only offline, and returns from server-owned ball to solo', () => {
    const { canvas, gl } = surface('webgl1');
    const onState = vi.fn();
    const handle = startMiniGolfPractice(canvas, onState);
    frames(3);
    expect(gl.drawArrays).toHaveBeenCalled();
    expect(handle?.setAuthoritativeBall(0, -3.8)).toBe(true);
    expect(handle?.shoot(0, 60)).toBe(false);
    expect(handle?.setAuthoritativeBall(Infinity, 0)).toBe(false);
    frames(3);
    handle?.leaveOnline();
    expect(handle?.state.strokes).toBe(0);
    expect(handle?.shoot(0, 60)).toBe(true);
    frames(35);
    expect(handle?.state.strokes).toBe(1);
    handle?.reset();
    expect(handle?.state.strokes).toBe(0);
    handle?.dispose();
    expect(gl.deleteProgram).toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });
  it('Mini Golf context loss revokes graphics and restores local-only rendering', () => {
    const { canvas, gl } = surface();
    const lost = vi.fn();
    const handle = startMiniGolfPractice(canvas, vi.fn(), lost);
    frames(2);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(lost).toHaveBeenCalledOnce();
    expect(handle?.isGraphicsAvailable).toBe(false);
    expect(handle?.shoot(0, 60)).toBe(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    frames(2);
    expect(handle?.isGraphicsAvailable).toBe(true);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    handle?.dispose();
  });
  it('Social 3D renders, admits only validated peers, sends movement intent not coordinates', () => {
    const { canvas, gl } = surface();
    const directions: string[] = [];
    const handle = startLocalSocialRoom(canvas, d => directions.push(d));
    expect(handle?.graphicsApi).toBe('webgl2');
    frames(3);
    expect(gl.drawArrays).toHaveBeenCalled();
    handle?.setQuality('low');
    handle?.setQuality('high');
    handle?.setQuality('invalid' as never);
    expect(handle?.setOnlinePeers([], 'socketA')).toBe(false);
    expect(handle?.setOnlinePeers([{ socketId:'socketA', userId:'alice', x:900, z:0 }], 'socketA')).toBe(false);
    const peers = [
      { socketId:'socketA', userId:'alice', x:0, z:2 },
      { socketId:'socketB', userId:'bob', x:1, z:2 },
    ];
    expect(handle?.setOnlinePeers(peers, 'socketA')).toBe(true);
    handle?.setDirection('right', true);
    frames(34);
    expect(directions).toContain('right');
    handle?.setDirection('right', false);
    handle?.leaveOnline();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key:'w', bubbles:true, cancelable:true }));
    frames(3);
    canvas.dispatchEvent(new KeyboardEvent('keyup', { key:'w', bubbles:true }));
    canvas.dispatchEvent(new Event('blur'));
    expect(gl.viewport).toHaveBeenCalled();
    handle?.dispose();
    expect(handle?.isGraphicsAvailable).toBe(false);
    expect(pending.size).toBe(0);
  });
  it('Social 3D context loss revokes online peers and restoration never silently rejoins', () => {
    const { canvas, gl } = surface('webgl1');
    const onLost = vi.fn(), onRestored = vi.fn();
    const handle = startLocalSocialRoom(canvas, vi.fn(), onLost, onRestored);
    expect(handle?.setOnlinePeers([{socketId:'a',userId:'alice',x:0,z:0}], 'a')).toBe(true);
    frames(2);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable:true }));
    expect(handle?.isGraphicsAvailable).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
    expect(handle?.setOnlinePeers([{socketId:'a',userId:'alice',x:0,z:0}], 'a')).toBe(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(onRestored).toHaveBeenCalledOnce();
    frames(3);
    expect(handle?.isGraphicsAvailable).toBe(true);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    handle?.dispose();
  });
  it('Hidden tabs suspend all three GPU loops and resume from visibility without a network join', () => {
    const golf = surface(), pool = surface(), room = surface();
    const handles = [
      startMiniGolfPractice(golf.canvas, vi.fn()),
      startPoolPractice(pool.canvas, vi.fn()),
      startLocalSocialRoom(room.canvas),
    ];
    frames(3);
    expect(pending.size).toBe(3);
    Object.defineProperty(document, 'hidden', { configurable:true, value:true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pending.size).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable:true, value:false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pending.size).toBe(3);
    handles.forEach(handle => handle?.dispose());
    expect(pending.size).toBe(0);
  });
});
