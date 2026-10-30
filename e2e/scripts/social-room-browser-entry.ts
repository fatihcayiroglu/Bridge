/**
 * Browser-only entrypoint for the E2E harness, NOT loaded by the shipped app.
 * Uses the REAL production browser SocialClient and WebGL renderer, and a real
 * socket.io-client connection to the production Socket.IO middleware fixture.
 */
import { io } from 'socket.io-client';
import { BridgeRegistry } from '../../client/js/core/bridge-registry.ts';
import { showBridgeActivities } from '../../client/js/core/activities/bridge-activities-panel.ts';
import { bindActivitiesEntry } from '../../client/js/core/activities/bridge-activities-entry.ts';
import { startLocalSocialRoom } from '../../client/js/core/activities/social-room-webgl.ts';
import { joinSocialRoomPreview, type SocialClient } from '../../client/js/core/activities/social-room-client.ts';
import type { Social3DSnapshot } from '../../client/js/core/activities/social-room-wire.ts';

export function mountSocialBrowser(
  port: number,
  token: string,
  serverId: string,
  forceWebGL1: boolean,
): void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:640px;height:400px;display:block';
  canvas.tabIndex = 0;
  document.body.replaceChildren(canvas);
  if (forceWebGL1) {
    const actual = canvas.getContext.bind(canvas);
    canvas.getContext = ((kind: string, attrs?: unknown) =>
      kind === 'webgl2' ? null : actual(kind as 'webgl', attrs as WebGLContextAttributes)) as typeof canvas.getContext;
  }
  const state: {
    status: string;
    errors: string[];
    frames: Social3DSnapshot[];
    api: string;
    socketId: string | undefined;
    session: SocialClient | null;
    socket: ReturnType<typeof io>;
    room: NonNullable<ReturnType<typeof startLocalSocialRoom>>;
    lastFrame: Social3DSnapshot | null;
    dispose: () => void;
    rejoin: () => void;
  } = {
    status: 'waiting-auth',
    errors: [], frames: [], api: '',
    socketId: undefined, session: null,
    socket: null as unknown as ReturnType<typeof io>,
    room: null as unknown as NonNullable<ReturnType<typeof startLocalSocialRoom>>,
    lastFrame: null,
    dispose: () => {}, rejoin: () => {},
  };
  const room = startLocalSocialRoom(canvas, direction => state.session?.step(direction),
    () => {
      state.session?.dispose();
      state.session = null;
      room?.leaveOnline();
      state.status = 'graphics-lost';
    });
  if (!room) throw Error('Actual WebGL context and renderer unavailable');
  state.room = room;
  state.api = room.graphicsApi;
  const socket = io('http://127.0.0.1:' + port, {
    auth: { token }, transports: ['websocket'],
    reconnection: false, forceNew: true, timeout: 7000,
  });
  state.socket = socket;
  socket.on('connect_error', error => {
    state.errors.push(String(error?.message || error));
    state.status = 'auth-error';
  });
  // Explicit rejoin is test-only: restoring WebGL must NOT silently restore
  // an online identity. The real shipped client has the same opt-in boundary.
  state.rejoin = () => {
    if (!socket.connected || !room.isGraphicsAvailable || state.session?.active) {
      throw Error('Explicit social rejoin requires a connected, ready offline renderer');
    }
    state.session = joinSocialRoomPreview(socket, serverId,
      (frame, ownSocketId) => {
        state.lastFrame = frame;
        state.frames.push(frame);
        return room.setOnlinePeers(frame.peers, ownSocketId);
      },
      status => {
        state.status = status;
        if (status !== 'online') room.leaveOnline();
      },
    );
  };
  socket.on('userAuthenticated', () => {
    state.socketId = socket.id;
    state.rejoin();
  });
  state.dispose = () => {
    state.session?.dispose();
    state.session = null;
    socket.disconnect();
    room.dispose();
  };
  (window as typeof window & { __bridge3DSmoke?: typeof state }).__bridge3DSmoke = state;
}

/**
 * Mount the exact shipped Activities panel and its registry integration in an
 * authenticated DOM fixture. The Socket.IO transport, Bridge JWT, WebGL and
 * PostgreSQL/Redis backend are REAL. The wider Bridge app shell/CSS are NOT
 * loaded here, so this is panel integration evidence, not full-shell E2E.
 */
export function mountRealActivitiesPanel(
  port: number,
  token: string,
  serverId: string,
): void {
  document.documentElement.lang = 'en';
  const app = document.createElement('main');
  app.id = 'app';
  document.body.replaceChildren(app);
  const socket = io('http://127.0.0.1:' + port, {
    auth: { token }, transports: ['websocket'],
    reconnection: false, forceNew: true, timeout: 7000,
  });
  const state = {
    ready: false,
    socket,
    errors: [] as string[],
    dispose: () => {
      document.dispatchEvent(new Event('bridge:auth-logout'));
      socket.disconnect();
      BridgeRegistry.unregister('socket');
      BridgeRegistry.unregister('getCurrentServer');
    },
  };
  BridgeRegistry.register('getCurrentServer', () => ({ _id: serverId }));
  // Production SocketManager uses a registry value for the canonical socket;
  // this explicit cast is confined to the test fixture, not app code.
  BridgeRegistry.register('socket', socket as never);
  socket.on('connect_error', error => state.errors.push(String(error?.message || error)));
  socket.on('userAuthenticated', () => {
    state.ready = true;
    showBridgeActivities('social');
  });
  (window as typeof window & { __bridge3DPanel?: typeof state }).__bridge3DPanel = state;
}

/**
 * Real shipped HTML opener and CSS integration. The fixture page is provided
 * by the real backend harness under a strict production-shaped CSP. This is
 * intentionally NOT full Bridge application boot/auth-shell E2E.
 */
export function mountShippedActivitiesOpener(
  port: number, token: string, serverId: string,
): void {
  const app = document.getElementById('app');
  const button = document.getElementById('bridge-activities-entry');
  if (!(app instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    throw Error('Real shipped Activities HTML opener missing');
  }
  const socket = io('http://127.0.0.1:' + port, {
    auth: { token }, transports: ['websocket'],
    reconnection: false, forceNew: true, timeout: 7000,
  });
  const state = {
    ready: false, socket, errors: [] as string[],
    dispose() {
      document.dispatchEvent(new Event('bridge:auth-logout'));
      socket.disconnect();
      BridgeRegistry.unregister('socket');
      BridgeRegistry.unregister('getCurrentServer');
    },
  };
  BridgeRegistry.register('getCurrentServer', () => ({ _id: serverId }));
  BridgeRegistry.register('socket', socket as never);
  app.style.display = 'flex'; // auth-gated display in the test-only shell fixture
  bindActivitiesEntry(); // the exact production click handler, never a fake opener
  socket.on('connect_error', error => state.errors.push(String(error?.message || error)));
  socket.on('userAuthenticated', () => { state.ready = true; });
  (window as typeof window & { __bridge3DShippedShell?: typeof state }).__bridge3DShippedShell = state;
}

/** Real second account for the full-SPA Mini Golf UI journey, no fake server. */
export function mountGolfOpponent(port: number, token: string, serverId: string): void {
  const socket = io('http://127.0.0.1:' + port, {
    auth: { token }, transports: ['websocket'],
    reconnection: false, forceNew: true, timeout: 7000,
  });
  const state = {
    ready: false, socket, states: [] as unknown[], errors: [] as unknown[],
    join() { socket.emit('mini-golf:join', { serverId }); },
    sync() { socket.emit('mini-golf:sync', { serverId }); },
    shoot(degrees: number, power: number) {
      socket.emit('mini-golf:shoot', { serverId, degrees, power });
    },
    async dispose() {
      // Deterministic cleanup of the previous two-player match before the
      // eight-seat test reuses its server. No blind sleep/retry.
      const left = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Mini Golf authoritative leave timed out')), 8000);
        socket.once('mini-golf:left', () => { clearTimeout(timer); resolve(); });
      });
      socket.emit('mini-golf:leave', { serverId });
      await left;
      socket.disconnect();
    },
  };
  socket.on('userAuthenticated', () => { state.ready = true; });
  socket.on('mini-golf:state', result => state.states.push(result));
  socket.on('mini-golf:error', result => state.errors.push(result));
  (window as typeof window & { __miniGolfOpponent?: typeof state }).__miniGolfOpponent = state;
}

/**
 * Eight-seat acceptance uses seven real independently authenticated sockets
 * (plus Alice in the full Bridge app). The eighth extra token tests overflow.
 * All traffic goes through production JWT middleware and PostgreSQL/Redis.
 */
export function mountGolfRoster(port: number, tokens: string[], serverId: string): void {
  function connect(token: string) {
    const socket = io('http://127.0.0.1:' + port, {
      auth: { token }, transports: ['websocket'],
      reconnection: false, forceNew: true, timeout: 7000,
    });
    const player = { socket, ready: false, states: [] as unknown[], errors: [] as unknown[] };
    socket.on('userAuthenticated', () => { player.ready = true; });
    socket.on('mini-golf:state', state => player.states.push(state));
    socket.on('mini-golf:error', error => player.errors.push(error));
    return player;
  }
  const players = tokens.map(connect);
  const state = {
    players,
    join(i: number) { players[i]!.socket.emit('mini-golf:join', { serverId }); },
    start(i: number) { players[i]!.socket.emit('mini-golf:start', { serverId }); },
    sync(i: number) { players[i]!.socket.emit('mini-golf:sync', { serverId }); },
    shoot(i: number, degrees: number, power: number) {
      players[i]!.socket.emit('mini-golf:shoot', { serverId, degrees, power });
    },
    leave(i: number) { players[i]!.socket.emit('mini-golf:leave', { serverId }); },
    /** A real transport drop. Never sends a voluntary leave. */
    drop(i: number) { players[i]!.socket.disconnect(); },
    /** New authenticated transport; NO implicit game rejoin. */
    reconnect(i: number) { players[i] = connect(tokens[i]!); },
    dispose() {
      for (const p of players) {
        p.socket.emit('mini-golf:leave', { serverId });
        p.socket.disconnect();
      }
    },
  };
  (window as typeof window & { __miniGolfRoster?: typeof state }).__miniGolfRoster = state;
}
