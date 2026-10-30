import {
  moveRoomAvatar, socialRoomAvatarGeometry, staticSocialRoomGeometry,
  type RoomPosition,
} from './social-room-geometry.ts';
import type { Social3DPeer } from './social-room-wire.ts';
import {
  selectSocialWebGLContext, socialRoomShaderSources, socialRoomRenderSize,
  SOCIAL_GRAPHICS_QUALITY, type SocialGraphicsApi, type SocialGraphicsQuality,
} from './social-room-render-policy.ts';

/**
 * Actual WebGL-rendered third-person 3D room, local-only proof of concept.
 * No remote libraries/assets, no sockets, no identity, no mic permission.
 * An optional network controller can supply authoritative positions and
 * send discrete movement intent; the renderer NEVER publishes coordinates.
 */
export type RoomDirection = 'forward' | 'back' | 'left' | 'right';
export interface SocialRoomHandle {
  readonly graphicsApi: SocialGraphicsApi;
  dispose(): void;
  setQuality(quality: SocialGraphicsQuality): void;
  /** A lost canvas keeps the session offline until a fresh explicit join. */
  readonly isGraphicsAvailable: boolean;
  setDirection(direction: RoomDirection, pressed: boolean): void;
  /** The caller must validate the bounded server snapshot before calling. */
  setOnlinePeers(peers: readonly Social3DPeer[], ownSocketId: string): boolean;
  leaveOnline(): void;
}

function perspective(aspect: number): Float32Array {
  const f = 1 / Math.tan(Math.PI / 5.1);
  const near = 0.1, far = 80;
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0,
  ]);
}

function viewMatrix(eye: readonly number[], at: readonly number[]): Float32Array {
  const norm = (v: number[]) => {
    const len = Math.hypot(...v) || 1;
    return v.map(n => n / len);
  };
  const z = norm([eye[0]! - at[0]!, eye[1]! - at[1]!, eye[2]! - at[2]!]);
  const x = norm([z[2]!, 0, -z[0]!]);
  const y = [
    z[1]! * x[2]! - z[2]! * x[1]!,
    z[2]! * x[0]! - z[0]! * x[2]!,
    z[0]! * x[1]! - z[1]! * x[0]!,
  ];
  return new Float32Array([
    x[0]!, y[0]!, z[0]!, 0,
    x[1]!, y[1]!, z[1]!, 0,
    x[2]!, y[2]!, z[2]!, 0,
    -(x[0]! * eye[0]! + x[1]! * eye[1]! + x[2]! * eye[2]!),
    -(y[0]! * eye[0]! + y[1]! * eye[1]! + y[2]! * eye[2]!),
    -(z[0]! * eye[0]! + z[1]! * eye[1]! + z[2]! * eye[2]!),
    1,
  ]);
}

function compileShader(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error('WebGL shader unavailable');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error('WebGL shader compilation failed');
  }
  return shader;
}


interface SocialGpuResources {
  vertex: WebGLShader;
  fragment: WebGLShader;
  program: WebGLProgram;
  staticBuffer: WebGLBuffer;
  avatarBuffer: WebGLBuffer;
  positionAttr: number;
  colorAttr: number;
  projectionUniform: WebGLUniformLocation;
  viewUniform: WebGLUniformLocation;
}

/**
 * All-or-nothing allocation. A partial shader, link or buffer failure must
 * never leave a half-initialized live renderer with an active RAF callback.
 */
function allocateSocialGpuResources(
  gl: WebGLRenderingContext,
  api: SocialGraphicsApi,
  staticData: Float32Array,
): SocialGpuResources {
  const shaders = socialRoomShaderSources(api);
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let staticBuffer: WebGLBuffer | null = null;
  let avatarBuffer: WebGLBuffer | null = null;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, shaders.vertex);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, shaders.fragment);
    program = gl.createProgram();
    if (!program) throw new Error('WebGL program unavailable');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL program link failed');
    staticBuffer = gl.createBuffer();
    avatarBuffer = gl.createBuffer();
    if (!staticBuffer || !avatarBuffer) throw new Error('WebGL buffer unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER, staticBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, staticData, gl.STATIC_DRAW);
    gl.useProgram(program);
    const positionAttr = gl.getAttribLocation(program, 'aPosition');
    const colorAttr = gl.getAttribLocation(program, 'aColor');
    const projectionUniform = gl.getUniformLocation(program, 'uProjection');
    const viewUniform = gl.getUniformLocation(program, 'uView');
    if (positionAttr < 0 || colorAttr < 0 || !projectionUniform || !viewUniform) {
      throw new Error('WebGL attributes unavailable');
    }
    gl.enableVertexAttribArray(positionAttr);
    gl.enableVertexAttribArray(colorAttr);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    return {
      vertex, fragment, program, staticBuffer, avatarBuffer,
      positionAttr, colorAttr, projectionUniform, viewUniform,
    };
  } catch (error) {
    if (avatarBuffer) gl.deleteBuffer(avatarBuffer);
    if (staticBuffer) gl.deleteBuffer(staticBuffer);
    if (program) gl.deleteProgram(program);
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    throw error;
  }
}

function destroySocialGpuResources(gl: WebGLRenderingContext, resources: SocialGpuResources): void {
  gl.deleteBuffer(resources.staticBuffer);
  gl.deleteBuffer(resources.avatarBuffer);
  gl.deleteProgram(resources.program);
  gl.deleteShader(resources.vertex);
  gl.deleteShader(resources.fragment);
}

export function startLocalSocialRoom(
  canvas: HTMLCanvasElement,
  onDirectionStep?: (direction: RoomDirection) => void,
  onGraphicsLost?: () => void,
  onGraphicsRestored?: () => void,
): SocialRoomHandle | null {
  const selected = selectSocialWebGLContext(canvas);
  if (!selected) return null;
  const { gl, api } = selected;
  const staticData = staticSocialRoomGeometry();
  // All handles are rebuilt after webglcontextrestored. The same WebGL context
  // object can survive, but shader/program/buffer objects never do.
  let resources: SocialGpuResources | null = allocateSocialGpuResources(gl, api, staticData);

  const pressed = new Set<RoomDirection>();
  let avatar: RoomPosition = { x: 0, z: 2.5 };
  let onlinePeers: readonly Social3DPeer[] | null = null;
  let ownSocketId: string | null = null;
  let lastNetworkStep = 0;
  let avatarChanged = true;
  let avatarVertexCount = 0;
  let disposed = false;
  let stoppedForContextLoss = false;
  let animationId = 0;
  let lastFrame = 0;
  let lastDraw = 0;
  let quality: SocialGraphicsQuality = 'balanced';

  function renderBuffer(gpu: SocialGpuResources, buffer: WebGLBuffer, vertexCount: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(gpu.positionAttr, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(gpu.colorAttr, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }
  function frame(timestamp: number): void {
    animationId = 0;
    if (disposed || stoppedForContextLoss || !resources || document.hidden || !canvas.isConnected) return;
    const gpu = resources;
    const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.05) : 0;
    lastFrame = timestamp;
    let dx = Number(pressed.has('right')) - Number(pressed.has('left'));
    let dz = Number(pressed.has('back')) - Number(pressed.has('forward'));
    if (dx !== 0 || dz !== 0) {
      if (onlinePeers !== null && onDirectionStep && timestamp - lastNetworkStep >= 350) {
        const direction: RoomDirection = Math.abs(dx) >= Math.abs(dz)
          ? (dx > 0 ? 'right' : 'left')
          : (dz > 0 ? 'back' : 'forward');
        lastNetworkStep = timestamp;
        onDirectionStep(direction); // intent only; coordinates remain server-owned
      } else if (onlinePeers === null) {
        const scale = Math.hypot(dx, dz);
        avatar = moveRoomAvatar(avatar, dx / scale * delta * 3, dz / scale * delta * 3);
        avatarChanged = true;
      }
    }
    // Quality-capped draw cadence; the host does not render while hidden.
    if (!lastDraw || timestamp - lastDraw >= 1000 / SOCIAL_GRAPHICS_QUALITY[quality].targetFps) {
      lastDraw = timestamp;
      const rect = canvas.getBoundingClientRect();
      const renderSize = socialRoomRenderSize(rect.width, rect.height, window.devicePixelRatio || 1, quality);
      const w = renderSize.width;
      const h = renderSize.height;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.useProgram(gpu.program);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.045, 0.075, 0.13, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(gpu.projectionUniform, false, perspective(w / h));
      gl.uniformMatrix4fv(gpu.viewUniform, false, viewMatrix(
        [avatar.x, 4.1, avatar.z + 8.5], [avatar.x, 0.9, avatar.z - 1.7],
      ));
      renderBuffer(gpu, gpu.staticBuffer, staticData.length / 6);
      if (avatarChanged) {
        const meshes = onlinePeers === null
          ? [socialRoomAvatarGeometry(avatar)]
          : onlinePeers.map(peer => socialRoomAvatarGeometry({ x: peer.x, z: peer.z }));
        const count = meshes.reduce((sum, mesh) => sum + mesh.length, 0);
        const combined = new Float32Array(count);
        let offset = 0;
        for (const mesh of meshes) { combined.set(mesh, offset); offset += mesh.length; }
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.avatarBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, combined, gl.DYNAMIC_DRAW);
        avatarVertexCount = count / 6;
        avatarChanged = false;
      }
      renderBuffer(gpu, gpu.avatarBuffer, avatarVertexCount);
    }
    animationId = requestAnimationFrame(frame);
  }
  function resume(): void {
    if (!disposed && !stoppedForContextLoss && resources && !document.hidden && !animationId) {
      lastFrame = 0;
      animationId = requestAnimationFrame(frame);
    }
  }
  function onVisibility(): void {
    if (document.hidden) {
      if (animationId) cancelAnimationFrame(animationId);
      animationId = 0;
      pressed.clear();
    } else resume();
  }
  function onKeyDown(event: KeyboardEvent): void {
    const movement: Record<string, RoomDirection> = {
      w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back',
      a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right',
    };
    const direction = movement[event.key];
    if (direction && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      pressed.add(direction);
    }
  }
  function onKeyUp(event: KeyboardEvent): void {
    const movement: Record<string, RoomDirection> = {
      w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back',
      a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right',
    };
    const direction = movement[event.key];
    if (direction) pressed.delete(direction);
  }
  function onContextLost(event: Event): void {
    event.preventDefault();
    stoppedForContextLoss = true;
    pressed.clear();
    if (animationId) cancelAnimationFrame(animationId);
    animationId = 0;
    // Every GPU handle is now invalid, and multiplayer must not be restored
    // automatically. The next successful restore only reopens local graphics.
    resources = null;
    onlinePeers = null;
    ownSocketId = null;
    lastNetworkStep = 0;
    avatarChanged = true;
    avatarVertexCount = 0;
    onGraphicsLost?.();
  }
  function onContextRestored(): void {
    if (disposed || !stoppedForContextLoss) return;
    try {
      resources = allocateSocialGpuResources(gl, api, staticData);
      stoppedForContextLoss = false;
      avatarChanged = true;
      avatarVertexCount = 0;
      lastFrame = 0;
      lastDraw = 0;
      pressed.clear();
      onGraphicsRestored?.();
      resume();
    } catch {
      // Keep the renderer failed closed. No auto-retry loop or GPU spin.
      resources = null;
      stoppedForContextLoss = true;
      onGraphicsLost?.();
    }
  }
  function onBlur(): void { pressed.clear(); }
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  document.addEventListener('visibilitychange', onVisibility);
  resume();
  return {
    graphicsApi: api,
    get isGraphicsAvailable() { return !disposed && !stoppedForContextLoss && resources !== null; },
    setQuality(nextQuality) {
      if (disposed) return;
      if (!['low', 'balanced', 'high'].includes(nextQuality)) return;
      quality = nextQuality;
      lastDraw = 0;
    },
    setDirection(direction, down) {
      if (disposed || stoppedForContextLoss) return;
      if (down) pressed.add(direction);
      else pressed.delete(direction);
    },
    setOnlinePeers(peers, selfId) {
      if (disposed || stoppedForContextLoss || !resources || !selfId || peers.length > 16 || !peers.some(p => p.socketId === selfId)) return false;
      if (peers.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z) || Math.abs(p.x) > 5.6 || Math.abs(p.z) > 5.2)) return false;
      onlinePeers = peers.map(p => ({ ...p }));
      ownSocketId = selfId;
      const me = onlinePeers.find(p => p.socketId === ownSocketId)!;
      avatar = { x: me.x, z: me.z };
      avatarChanged = true;
      return true;
    },
    leaveOnline() {
      onlinePeers = null;
      ownSocketId = null;
      lastNetworkStep = 0;
      avatarChanged = true;
      pressed.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pressed.clear();
      if (animationId) cancelAnimationFrame(animationId);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      document.removeEventListener('visibilitychange', onVisibility);
      if (resources && !stoppedForContextLoss) destroySocialGpuResources(gl, resources);
      resources = null;
      onlinePeers = null;
      ownSocketId = null;
    },
  };
}
