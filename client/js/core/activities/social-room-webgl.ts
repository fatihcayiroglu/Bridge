import {
  moveRoomAvatar, socialRoomAvatarGeometry, staticSocialRoomGeometry,
  type RoomPosition,
} from './social-room-geometry.ts';

/**
 * Actual WebGL-rendered third-person 3D room, local-only proof of concept.
 * No remote libraries/assets, no sockets, no identity, no mic permission.
 * A multiplayer feature must not reuse client-owned coordinates as authority.
 */
export type RoomDirection = 'forward' | 'back' | 'left' | 'right';
export interface SocialRoomHandle {
  dispose(): void;
  setDirection(direction: RoomDirection, pressed: boolean): void;
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

export function startLocalSocialRoom(canvas: HTMLCanvasElement): SocialRoomHandle | null {
  const context = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'low-power' });
  if (!context) return null;
  // A narrowed local captured by RAF callbacks; DOM getContext() is nullable.
  const gl: WebGLRenderingContext = context;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, [
    'attribute vec3 aPosition;', 'attribute vec3 aColor;',
    'uniform mat4 uProjection;', 'uniform mat4 uView;', 'varying vec3 vColor;',
    'void main() { vColor = aColor; gl_Position = uProjection * uView * vec4(aPosition, 1.0); }',
  ].join('\n'));
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, [
    'precision mediump float;', 'varying vec3 vColor;',
    'void main() { gl_FragColor = vec4(vColor, 1.0); }',
  ].join('\n'));
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program unavailable');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL program link failed');
  const staticBuffer = gl.createBuffer();
  const avatarBuffer = gl.createBuffer();
  if (!staticBuffer || !avatarBuffer) throw new Error('WebGL buffer unavailable');
  const staticData = staticSocialRoomGeometry();
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

  const pressed = new Set<RoomDirection>();
  let avatar: RoomPosition = { x: 0, z: 2.5 };
  let avatarChanged = true;
  let avatarVertexCount = 0;
  let disposed = false;
  let stoppedForContextLoss = false;
  let animationId = 0;
  let lastFrame = 0;
  let lastDraw = 0;

  function renderBuffer(buffer: WebGLBuffer, vertexCount: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(positionAttr, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(colorAttr, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }
  function frame(timestamp: number): void {
    animationId = 0;
    if (disposed || stoppedForContextLoss || document.hidden || !canvas.isConnected) return;
    const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.05) : 0;
    lastFrame = timestamp;
    let dx = Number(pressed.has('right')) - Number(pressed.has('left'));
    let dz = Number(pressed.has('back')) - Number(pressed.has('forward'));
    if (dx !== 0 || dz !== 0) {
      const scale = Math.hypot(dx, dz);
      dx /= scale; dz /= scale;
      avatar = moveRoomAvatar(avatar, dx * delta * 3, dz * delta * 3);
      avatarChanged = true;
    }
    // ~30 FPS cap; the host does not render while the room tab is hidden.
    if (!lastDraw || timestamp - lastDraw >= 33) {
      lastDraw = timestamp;
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(rect.width * pixelRatio));
      const h = Math.max(1, Math.floor(rect.height * pixelRatio));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.045, 0.075, 0.13, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(projectionUniform, false, perspective(w / h));
      gl.uniformMatrix4fv(viewUniform, false, viewMatrix(
        [avatar.x, 4.1, avatar.z + 8.5], [avatar.x, 0.9, avatar.z - 1.7],
      ));
      renderBuffer(staticBuffer, staticData.length / 6);
      if (avatarChanged) {
        const mesh = socialRoomAvatarGeometry(avatar);
        gl.bindBuffer(gl.ARRAY_BUFFER, avatarBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);
        avatarVertexCount = mesh.length / 6;
        avatarChanged = false;
      }
      renderBuffer(avatarBuffer, avatarVertexCount);
    }
    animationId = requestAnimationFrame(frame);
  }
  function resume(): void {
    if (!disposed && !stoppedForContextLoss && !document.hidden && !animationId) {
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
    if (animationId) cancelAnimationFrame(animationId);
    animationId = 0;
  }
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', () => pressed.clear());
  canvas.addEventListener('webglcontextlost', onContextLost);
  document.addEventListener('visibilitychange', onVisibility);
  resume();
  return {
    setDirection(direction, down) {
      if (disposed) return;
      if (down) pressed.add(direction);
      else pressed.delete(direction);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pressed.clear();
      if (animationId) cancelAnimationFrame(animationId);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteBuffer(staticBuffer); gl.deleteBuffer(avatarBuffer);
      gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    },
  };
}
