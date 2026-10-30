import { readSocial3DSnapshot, type Social3DSnapshot } from './social-room-wire.ts';

export interface SocialSocket {
  connected: boolean;
  id?: string;
  on(event: string, listener: (data?: unknown) => void): void;
  off(event: string, listener: (data?: unknown) => void): void;
  emit(event: string, data?: unknown): void;
}

export type SocialClientStatus = 'connecting' | 'online' | 'unavailable' | 'disconnected' | 'invalid';
export interface SocialClient {
  readonly active: boolean;
  dispose(): void;
  step(direction: 'forward' | 'back' | 'left' | 'right'): void;
}

/**
 * Explicit opt-in connection to the server-owned 3D room protocol.
 * Never joins an unknown current server; never creates its own socket or asks
 * for mic/camera. Only server-validated peer frames may reach WebGL.
 *
 * This is behind a disabled-by-default server gate; timeout means unavailable,
 * NOT a successful session. Reconnection is not automatic.
 */
export function joinSocialRoomPreview(
  socket: SocialSocket,
  serverId: string,
  onSnapshot: (frame: Social3DSnapshot, ownSocketId: string) => boolean,
  onStatus: (status: SocialClientStatus) => void,
): SocialClient {
  let disposed = false;
  let joined = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const ownSocketId = socket.id;
  const serverIsValid = /^[a-zA-Z0-9_-]{1,64}$/.test(serverId);
  if (!serverIsValid || !ownSocketId || !socket.connected) {
    onStatus('unavailable');
    return { active: false, dispose() {}, step() {} };
  }

  function stop(status: SocialClientStatus, leave: boolean): void {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadline);
    socket.off('social:joined', onJoined);
    socket.off('social:peers', onPeers);
    socket.off('social:error', onError);
    socket.off('social:left', onLeft);
    socket.off('disconnect', onDisconnect);
    // Even an outstanding join is canceled on client teardown. The server is
    // separately required to handle an in-flight join/leave race.
    if (leave && socket.connected) socket.emit('social:leave', { serverId });
    joined = false;
    onStatus(status);
  }

  function acceptSnapshot(raw: unknown): void {
    const frame = readSocial3DSnapshot(raw, serverId);
    if (!frame || !frame.peers.some(peer => peer.socketId === ownSocketId)) {
      stop('invalid', true);
      return;
    }
    if (!onSnapshot(frame, ownSocketId!)) {
      stop('invalid', true);
    }
  }
  function onJoined(raw?: unknown): void {
    if (disposed) return;
    const frame = readSocial3DSnapshot(raw, serverId);
    if (!frame || !frame.peers.some(peer => peer.socketId === ownSocketId)) {
      stop('invalid', true);
      return;
    }
    clearTimeout(deadline);
    joined = true;
    onStatus('online');
    acceptSnapshot(frame);
  }
  function onPeers(raw?: unknown): void {
    if (!disposed && joined) acceptSnapshot(raw);
  }
  function onError(raw?: unknown): void {
    if (!disposed && raw && typeof raw === 'object' &&
        'code' in raw && typeof raw.code === 'string') {
      stop('unavailable', false);
    }
  }
  function onLeft(raw?: unknown): void {
    if (raw && typeof raw === 'object' && 'serverId' in raw && raw.serverId === serverId) {
      stop('disconnected', false);
    }
  }
  function onDisconnect(): void { stop('disconnected', false); }

  socket.on('social:joined', onJoined);
  socket.on('social:peers', onPeers);
  socket.on('social:error', onError);
  socket.on('social:left', onLeft);
  socket.on('disconnect', onDisconnect);
  deadline = setTimeout(() => stop('unavailable', true), 7000);
  onStatus('connecting');
  socket.emit('social:join', { serverId });
  return {
    get active() { return !disposed; },
    step(direction) {
      if (disposed || !joined || !socket.connected) return;
      socket.emit('social:step', { serverId, direction });
    },
    dispose() { stop('disconnected', true); },
  };
}
