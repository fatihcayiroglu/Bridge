/**
 * Browser-only entrypoint for the E2E harness, NOT loaded by the shipped app.
 * Uses the REAL production browser SocialClient and WebGL renderer, and a real
 * socket.io-client connection to the production Socket.IO middleware fixture.
 */
import { io } from 'socket.io-client';
import { BridgeRegistry } from '../../client/js/core/bridge-registry.ts';
import { showBridgeActivities } from '../../client/js/core/activities/bridge-activities-panel.ts';
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
