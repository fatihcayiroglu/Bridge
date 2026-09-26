/**
 * Bridge Server — Global Type Declarations
 */
import type { JwtPayload } from '../middleware/auth';
import type { Channel, Server, User } from '../db/repositories/types/entities';

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
      authed?: JwtPayload;
      adminUser?: User;
      channel?: Channel;
      server?: Server;
    }
  }

  interface Error {
    data?: Record<string, unknown>;
  }
}


declare module 'socket.io' {
  interface Socket {
    userId?: string;
    username?: string;
    tokenV?: number;
    tokenExp?: number;
    isBot?: boolean;
    botId?: string;
    botServerId?: string;
    currentVoiceChannel?: string | null;
    currentVoiceServer?: string | null;
    currentStageChannel?: string;
    _clientIp?: string;
  }
}

export {};
