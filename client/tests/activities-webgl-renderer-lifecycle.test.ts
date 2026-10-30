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
  it('Pool only applies valid local cue placement to the actual GPU scene, never moving or disconnected',()=>{
    const {canvas,gl}=surface('webgl1');
    const updated=vi.fn();
    const handle=startPoolPractice(canvas,updated);
    expect(handle).not.toBeNull();
    const initial=handle!.state;
    const candidate={...initial,balls:initial.balls.map(b=>
      b.id===0?{...b,x:.55,z:2.5}:b)};
    expect(handle?.placeLocalTable(candidate)).toBe(true);
    expect(handle?.state.balls[0]).toMatchObject({x:.55,z:2.5});
    expect(updated).toHaveBeenCalledTimes(2);
    frames(3);
    expect(gl.bufferData).toHaveBeenCalled();
    expect(handle?.placeLocalTable({...candidate,shots:12})).toBe(false);
    expect(handle?.shoot(0,50)).toBe(true);
    expect(handle?.placeLocalTable(candidate)).toBe(false);
    canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
    expect(handle?.placeLocalTable(candidate)).toBe(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    handle?.reset();
    expect(handle?.state.shots).toBe(0);
    handle?.dispose();
    expect(handle?.placeLocalTable(candidate)).toBe(false);
    expect(pending.size).toBe(0);
  });
  it('Pool observer snapshots cannot tamper with authoritative balls or pocket evidence', () => {
    const {canvas}=surface();
    let callbacks=0;
    const game=startPoolPractice(canvas, snapshot=>{
      callbacks++;
      // A hostile/misbehaving UI callback must not change the physics state.
      (snapshot.balls[0] as {x:number}).x=100;
      (snapshot.balls as unknown as unknown[]).push({id:16});
      (snapshot.breakObjectRails as number[]).push(15);
      (snapshot.pocketEvents as {ballId:number;pocketIndex:number}[])
        .push({ballId:8,pocketIndex:0});
    });
    expect(game).not.toBeNull();
    const exposed=game!.state;
    (exposed.balls[0] as {x:number}).x=-100;
    (exposed.balls as unknown as unknown[]).pop();
    (exposed.breakObjectRails as number[]).push(1);
    (exposed.pocketEvents as {ballId:number;pocketIndex:number}[])
      .push({ballId:8,pocketIndex:1});
    expect(game!.state.balls).toHaveLength(16);
    expect(game!.state.balls[0]?.x).toBe(0);
    expect(game!.state.breakObjectRails).toEqual([]);
    expect(game!.state.pocketEvents).toEqual([]);
    expect(game!.shoot(0,55)).toBe(true);
    frames(5);
    expect(callbacks).toBeGreaterThan(1);
    expect(game!.state.balls).toHaveLength(16);
    expect(game!.state.balls[0]!.x).not.toBe(100);
    expect(game!.state.breakObjectRails).not.toContain(15);
    expect(game!.state.pocketEvents).toEqual([]);
    game!.reset();
    const ready=game!.state;
    const placed={...ready,balls:ready.balls.map(b=>b.id===0?{...b,x:.55,z:2.5}:b)};
    expect(game!.placeLocalTable(placed)).toBe(true);
    expect(game!.state.balls[0]?.x).toBe(.55);
    game!.dispose();
    expect(pending.size).toBe(0);
  });
  it('Pool refuses detached canvases and stale handles cannot shoot or change placement after unmount', () => {
    const unattached=document.createElement('canvas');
    expect(startPoolPractice(unattached,vi.fn())).toBeNull();
    const {canvas}=surface();
    const onState=vi.fn();
    const game=startPoolPractice(canvas,onState);
    expect(game?.isGraphicsAvailable).toBe(true);
    const original=game!.state;
    const moved={...original,balls:original.balls.map(b=>
      b.id===0?{...b,x:.55,z:2.5}:b)};
    canvas.remove();
    expect(game?.isGraphicsAvailable).toBe(false);
    expect(game?.shoot(0,60)).toBe(false);
    expect(game?.placeLocalTable(moved)).toBe(false);
    game?.reset();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(game?.state.shots).toBe(0);
    expect(game?.state.balls[0]?.x).toBe(0);
    frames(3);
    expect(pending.size).toBe(0);
    document.body.append(canvas);
    expect(game?.isGraphicsAvailable).toBe(false);
    expect(game?.shoot(0,60)).toBe(false);
    expect(game?.placeLocalTable(moved)).toBe(false);
    game?.dispose();
    expect(pending.size).toBe(0);
  });
  it('Pool uploads 16 full spheres with real white caps for stripes 9–15, colored solids and a dark eight', () => {
    const { canvas, gl } = surface('webgl1');
    const game = startPoolPractice(canvas, vi.fn());
    expect(game?.state.balls).toHaveLength(16);
    frames(3);
    const captured = (gl.bufferData as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const dynamic = captured.find(call => call[2] === gl.DYNAMIC_DRAW)?.[1];
    expect(dynamic).toBeInstanceOf(Float32Array);
    const verticesPerBall = 8 * 12 * 6;
    const floatsPerBall = verticesPerBall * 6;
    const data = dynamic as Float32Array;
    expect(data.length).toBe(16 * floatsPerBall);
    const color = (id:number,latitudeRow:number) => {
      const position = game!.state.balls.findIndex(ball => ball.id === id);
      expect(position).toBeGreaterThanOrEqual(0);
      const firstVertex = position * floatsPerBall + latitudeRow * 12 * 6 * 6;
      return Array.from(data.slice(firstVertex + 3, firstVertex + 6));
    };
    const stripeTop = color(9, 0);
    const stripeBelt = color(9, 3);
    const stripeBottom = color(9, 7);
    expect(stripeTop[0]).toBeCloseTo(.96, 4);
    expect(stripeTop[2]).toBeCloseTo(.93, 4);
    expect(stripeBelt[2]).toBeLessThan(.60);
    expect(stripeBottom[0]).toBeGreaterThan(.60);
    expect(color(1, 0)[2]).toBeCloseTo(.15, 4); // solid yellow, not white
    expect(color(8, 0)[0]).toBeLessThan(.1); // eight ball remains black
    game?.dispose();
    expect(pending.size).toBe(0);
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
